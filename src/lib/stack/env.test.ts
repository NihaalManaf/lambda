import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { copyEnvFiles, envFileSecrets, parseDotenv, redactor, serviceEnv, unwiredLocalRefs } from "./env";
import { allocatePorts, portFree } from "./ports";
import { RESERVED_PORTS } from "./plan";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lambda-stack-env-")));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("env files", () => {
  const repo = path.join(tmp, "repo");
  const wt = path.join(tmp, "wt");
  fs.mkdirSync(path.join(repo, "api"), { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(repo, "api/.env"), "API_KEY=supersecretvalue123\nDEBUG=true\n", { mode: 0o644 });

  it("copies missing files 0600, then reports current, re-copies when changed", () => {
    expect(copyEnvFiles(repo, wt, ["api/.env", "frontend/.env.local"])).toEqual([
      { file: "api/.env", status: "copied" },
      { file: "frontend/.env.local", status: "missing" },
    ]);
    const dst = path.join(wt, "api/.env");
    expect(fs.readFileSync(dst, "utf8")).toContain("API_KEY=");
    expect(fs.statSync(dst).mode & 0o777).toBe(0o600);
    expect(copyEnvFiles(repo, wt, ["api/.env"])).toEqual([{ file: "api/.env", status: "current" }]);
    fs.writeFileSync(path.join(repo, "api/.env"), "API_KEY=rotatedsecretvalue456\n");
    expect(copyEnvFiles(repo, wt, ["api/.env"])[0].status).toBe("copied");
    expect(fs.readFileSync(dst, "utf8")).toContain("rotated");
  });

  it("never writes through a symlink in the worktree, never touches the repo", () => {
    const victim = path.join(tmp, "victim.txt");
    fs.writeFileSync(victim, "keep");
    const dst = path.join(wt, "api/.env");
    fs.rmSync(dst);
    fs.symlinkSync(victim, dst);
    const before = fs.readFileSync(path.join(repo, "api/.env"), "utf8");
    copyEnvFiles(repo, wt, ["api/.env"]);
    expect(fs.readFileSync(victim, "utf8")).toBe("keep");
    expect(fs.lstatSync(dst).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(repo, "api/.env"), "utf8")).toBe(before);
  });

  it("refuses files outside the repo (paths or symlinks)", () => {
    expect(() => copyEnvFiles(repo, wt, ["../outside"])).toThrow(/outside/);
    fs.writeFileSync(path.join(tmp, "secret.txt"), "x");
    fs.symlinkSync(path.join(tmp, "secret.txt"), path.join(repo, ".env.link"));
    expect(() => copyEnvFiles(repo, wt, [".env.link"])).toThrow(/outside/);
  });

  it("parses dotenv and picks secret-looking values", () => {
    expect(parseDotenv('export A="x y"\nB=plain # c\n# skip\nC=\'q\'')).toEqual({ A: "x y", B: "plain", C: "q" });
    const s = envFileSecrets(repo, ["api/.env"]);
    expect(s).toContain("rotatedsecretvalue456");
    expect(s).not.toContain("true");
  });
});

describe("redaction", () => {
  it("masks literal secrets, encoded forms and common token shapes", () => {
    const r = redactor(["supersecretvalue123", "p@ss word!"]);
    expect(r("key=supersecretvalue123 ok")).toBe("key=••• ok");
    expect(r(`url ${encodeURIComponent("p@ss word!")}`)).toBe("url •••");
    expect(r("Authorization: Bearer abcdefghijklmnop1234")).toBe("Authorization: Bearer •••");
    expect(r("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")).toBe("token •••jwt");
    expect(r("postgres://user:hunter22@db.example.com/x")).toBe("postgres://user:•••@db.example.com/x");
    expect(r("password=hunter22")).toBe("password=•••");
    expect(r("nothing to see")).toBe("nothing to see");
  });
});

describe("service env", () => {
  it("keeps only allowlisted inherited vars and applies extras", () => {
    const env = serviceEnv(
      { PATH: "/bin", PORT: "4900", NODE_ENV: "development", __NEXT_PRIVATE_X: "1", npm_package_name: "lambda", HOME: "/h", API_URL: "http://localhost:8000", ANTHROPIC_API_KEY: "sk-x", LC_ALL: "C" } as NodeJS.ProcessEnv,
      { PORT: "5555" },
    );
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/h", LC_ALL: "C", PORT: "5555", BROWSER: "none" });
    for (const k of ["NODE_ENV", "__NEXT_PRIVATE_X", "npm_package_name", "API_URL", "ANTHROPIC_API_KEY"]) expect(env[k]).toBeUndefined();
  });

  it("never lets plan extras set loader keys", () => {
    const env = serviceEnv({ PATH: "/bin", NODE_ENV: "test" } as NodeJS.ProcessEnv, { NODE_OPTIONS: "--require /tmp/x.js", DYLD_INSERT_LIBRARIES: "/x", PATH: "/evil", PYTHONPATH: "/x", PYTHONUNBUFFERED: "1", API: "ok" });
    expect(env).toMatchObject({ PATH: "/bin", PYTHONUNBUFFERED: "1", API: "ok" });
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(env.PYTHONPATH).toBeUndefined();
  });
});

describe("env files: leftovers and localhost refs", () => {
  it("removes lambda's copy when the source env file is gone", () => {
    const repo = path.join(tmp, "repo2");
    const wt = path.join(tmp, "wt2");
    fs.mkdirSync(path.join(repo, "api"), { recursive: true });
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(repo, "api/.env"), "A=1\n");
    copyEnvFiles(repo, wt, ["api/.env"]);
    fs.rmSync(path.join(repo, "api/.env"));
    expect(copyEnvFiles(repo, wt, ["api/.env"])).toEqual([{ file: "api/.env", status: "removed" }]);
    expect(fs.existsSync(path.join(wt, "api/.env"))).toBe(false);
    expect(copyEnvFiles(repo, wt, ["api/.env"])).toEqual([{ file: "api/.env", status: "missing" }]);
  });

  it("lists env keys still pointing at the developer's localhost the plan doesn't override", () => {
    const repo = path.join(tmp, "repo3");
    fs.mkdirSync(path.join(repo, "frontend"), { recursive: true });
    fs.mkdirSync(path.join(repo, "api"), { recursive: true });
    fs.writeFileSync(path.join(repo, "frontend/.env.local"), "API_URL=http://localhost:8000\nNEXT_PUBLIC_API_URL=http://localhost:8000\nX=hello\n");
    fs.writeFileSync(path.join(repo, "api/.env"), "API_BASE_URL=http://127.0.0.1:8001/v1\nDATABASE_URL=postgres://u:p@localhost:5432/db\n");
    const refs = unwiredLocalRefs(repo, {
      envFiles: ["frontend/.env.local", "api/.env"],
      env: { frontend: { NEXT_PUBLIC_API_URL: "${url:api}" }, api: {} },
      services: [
        { name: "frontend", cwd: "frontend" },
        { name: "api", cwd: "api" },
      ],
    });
    expect(refs.map((r) => `${r.key}:${r.port}`).sort()).toEqual(["API_BASE_URL:8001", "API_URL:8000", "DATABASE_URL:5432"]);
  });
});

describe("ports", () => {
  it("allocates distinct free ports, never the developer's, keeps a free preferred one", async () => {
    const [a, b, c] = await allocatePorts(3);
    expect(new Set([a, b, c]).size).toBe(3);
    for (const p of [a, b, c]) expect(RESERVED_PORTS).not.toContain(p);
    const again = await allocatePorts(2, { preferred: [a, 3000] });
    expect(again[0]).toBe(a);
    expect(again[1]).not.toBe(3000);
  });

  it("skips a preferred port that is taken", async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const busy = (srv.address() as net.AddressInfo).port;
    expect(await portFree(busy)).toBe(false);
    const [p] = await allocatePorts(1, { preferred: [busy] });
    expect(p).not.toBe(busy);
    await new Promise((r) => srv.close(r));
  });
});
