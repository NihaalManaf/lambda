import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { validatePlan } from "./plan";
import { groupAlive, Ring, startProc } from "./proc";
import { readState, StackRun } from "./runner";
import type { StackPlan } from "../types";

// Real processes: tiny node http servers stand in for frontend / api, a log-ready worker, a setup step.

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lambda-stack-run-")));
const repo = path.join(tmp, "repo");
const wt = path.join(tmp, "wt");
for (const d of [path.join(repo, "api"), path.join(wt, "api"), path.join(wt, "web")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(repo, "api/.env"), "API_KEY=supersecretvalue123\n");
const node = process.execPath;

// api: serves on $PORT, logs its secret (must come out redacted), forks a grandchild that records its pid
const API = `
const http = require("http"), fs = require("fs"), { spawn } = require("child_process");
const key = fs.readFileSync(".env", "utf8").match(/API_KEY=(.*)/)[1];
console.log("loaded key " + key);
const kid = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
fs.writeFileSync("grandchild.pid", String(kid.pid));
http.createServer((q, r) => r.end("api ok")).listen(Number(process.env.PORT), "127.0.0.1", () => console.log("api up"));
`;
// web: answers with the api url it was wired to
const WEB = `
const http = require("http");
const port = Number(process.argv[process.argv.length - 1]);
http.createServer((q, r) => r.end(process.env.API_URL)).listen(port, "127.0.0.1");
`;

const raw = {
  services: [
    { name: "api", role: "api", cwd: "api", cmd: [node, "-e", API], port: { env: "PORT" }, ready: { path: "/", timeoutSec: 20 } },
    { name: "web", role: "frontend", cwd: "web", cmd: [node, "-e", WEB, "--"], port: { arg: "--port" }, ready: { path: "/", status: 200, timeoutSec: 20 } },
    { name: "worker", role: "worker", cwd: ".", cmd: [node, "-e", "setTimeout(()=>console.log('worker ready'),300);setInterval(()=>{},1000)"], ready: { log: "worker ready", timeoutSec: 20 } },
    { name: "extra", role: "other", cwd: ".", cmd: [node, "-e", "setInterval(()=>{},1000)"], optional: true },
  ],
  setup: [{ name: "marker", cwd: ".", cmd: [node, "-e", "require('fs').writeFileSync('marker', String(Date.now()))"], skipIf: "marker" }],
  env: { web: { API_URL: "${url:api}" } },
  envFiles: ["api/.env"],
  notes: [],
};
const v = validatePlan(raw);
if (!("plan" in v)) throw new Error(v.error);
const plan: StackPlan = v.plan;

const runs: StackRun[] = [];
afterAll(async () => {
  for (const r of runs) await r.stop().catch(() => undefined);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const mk = (p = plan, file = "s.state.json") => {
  const r = new StackRun({ key: "k", worktree: wt, repoPath: repo, ref: "main", plan: p, stateFile: path.join(tmp, file), baseEnv: process.env });
  runs.push(r);
  return r;
};

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("stack runner", () => {
  it("copies env, runs setup once, starts services on fresh ports, wires urls, redacts logs, stops the whole group", async () => {
    const r = mk();
    const st = await r.start();
    expect(st.status).toBe("ready");
    const api = st.services.find((s) => s.name === "api")!;
    const web = st.services.find((s) => s.name === "web")!;
    expect(st.services.find((s) => s.name === "extra")!.status).toBe("stopped"); // optional: not started
    expect(api.port).toBeGreaterThan(1024);
    expect(web.port).not.toBe(api.port);
    expect(fs.statSync(path.join(wt, "api/.env")).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(wt, "marker"))).toBe(true);

    // frontend got the api's url through the placeholder
    expect(await (await fetch(`http://127.0.0.1:${web.port}/`)).text()).toBe(`http://localhost:${api.port}`);
    expect(r.urlOf("frontend")).toBe(`http://localhost:${web.port}`);

    // the secret never reaches the ring buffer
    const lines = r.logs(0).lines.map((l) => l.line);
    expect(lines.join("\n")).toContain("loaded key •••");
    expect(lines.join("\n")).not.toContain("supersecretvalue123");
    expect(r.logs(0, "api").lines.every((l) => l.service === "api")).toBe(true);
    const last = r.logs(0).last;
    expect(r.logs(last).lines).toEqual([]);

    // state persisted with pgids
    const saved = readState(path.join(tmp, "s.state.json"))!;
    expect(saved.status).toBe("ready");
    expect(saved.services.find((s) => s.name === "api")!.pid).toBe(api.pid);

    // stop takes the grandchild down too (process group)
    const grand = Number(fs.readFileSync(path.join(wt, "api/grandchild.pid"), "utf8"));
    expect(pidAlive(grand)).toBe(true);
    const stopped = await r.stop();
    expect(stopped.status).toBe("stopped");
    await new Promise((res) => setTimeout(res, 200));
    expect(pidAlive(grand)).toBe(false);
    expect(groupAlive(api.pid!)).toBe(false);
    expect(readState(path.join(tmp, "s.state.json"))!.services.every((s) => !s.pid)).toBe(true);

    // restart: setup skipped (marker exists), same ports when still free
    const marker = fs.readFileSync(path.join(wt, "marker"), "utf8");
    const again = await r.start();
    expect(again.status).toBe("ready");
    expect(fs.readFileSync(path.join(wt, "marker"), "utf8")).toBe(marker);
    expect(r.logs(0, "setup").lines.some((l) => /skipped/.test(l.line))).toBe(true);
    expect(again.services.find((s) => s.name === "api")!.port).toBe(api.port);

    // one service restart, optional service on demand
    const re = await r.restart("api");
    expect(re.services.find((s) => s.name === "api")!.status).toBe("ready");
    const ex = await r.startService("extra");
    expect(ex.services.find((s) => s.name === "extra")!.status).toBe("ready");
    await r.stop();
  });

  it("marks a service that dies as crashed / error and the stack as not ready", async () => {
    const p = validatePlan({
      services: [
        { name: "ok", role: "api", cwd: ".", cmd: [node, "-e", "setInterval(()=>{},1000)"] },
        { name: "boom", role: "frontend", cwd: ".", cmd: [node, "-e", "console.error('nope'); process.exit(3)"], port: { env: "PORT" }, ready: { path: "/", timeoutSec: 10 } },
      ],
    });
    if (!("plan" in p)) throw new Error(p.error);
    const r = mk(p.plan, "crash.state.json");
    const st = await r.start();
    const boom = st.services.find((s) => s.name === "boom")!;
    expect(["error", "crashed"]).toContain(boom.status);
    expect(st.status).toBe("partial");
    expect(r.logs(0, "boom").lines.map((l) => l.line).join("\n")).toMatch(/nope|exited/);
    await r.stop();
  });

  it("takes the whole group down when the leader exits, and records pids until it's gone", async () => {
    // leader forks a child (same group) that ignores SIGTERM-free shutdown, then exits
    const LEADER = `const { spawn } = require("child_process"); const k = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); require("fs").writeFileSync("orphan.pid", String(k.pid)); setTimeout(() => process.exit(0), 300);`;
    const p = validatePlan({ services: [{ name: "lead", role: "worker", cwd: ".", cmd: [node, "-e", LEADER], ready: { log: "never", timeoutSec: 5 } }] });
    if (!("plan" in p)) throw new Error(p.error);
    const r = mk(p.plan, "leader.state.json");
    const started = r.start();
    await new Promise((res) => setTimeout(res, 250));
    const pgid = r.state().services[0].pid!;
    expect(pgid).toBeGreaterThan(1);
    await started;
    for (let i = 0; i < 60 && groupAlive(pgid); i++) await new Promise((res) => setTimeout(res, 100));
    expect(groupAlive(pgid)).toBe(false);
    const orphan = Number(fs.readFileSync(path.join(wt, "orphan.pid"), "utf8"));
    expect(pidAlive(orphan)).toBe(false);
    expect(r.pgids()).toEqual([]);
    expect(readState(path.join(tmp, "leader.state.json"))?.services[0].pid).toBeUndefined();
  });

  it("re-runs a skipIf setup step when its lockfile changes (git-ignored target only)", async () => {
    const wt2 = path.join(tmp, "wt-stamp");
    fs.mkdirSync(wt2, { recursive: true });
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q"], { cwd: wt2 });
    fs.writeFileSync(path.join(wt2, "package-lock.json"), "v1");
    const p = validatePlan({
      services: [{ name: "a", role: "api", cwd: ".", cmd: [node, "-e", "setInterval(()=>{},1000)"] }],
      setup: [{ name: "mods", cwd: ".", cmd: [node, "-e", "require('fs').mkdirSync('mods');require('fs').appendFileSync('runs','x')"], skipIf: "mods" }],
    });
    if (!("plan" in p)) throw new Error(p.error);
    const mk2 = () => {
      const r = new StackRun({ key: "k2", worktree: wt2, repoPath: repo, ref: "main", plan: p.plan, stateFile: path.join(tmp, "stamp.state.json"), baseEnv: process.env });
      runs.push(r);
      return r;
    };
    const r1 = mk2();
    await r1.start();
    await r1.stop();
    await mk2().start().then(() => runs[runs.length - 1].stop()); // same lockfile: skipped
    expect(fs.readFileSync(path.join(wt2, "runs"), "utf8")).toBe("x");
    fs.writeFileSync(path.join(wt2, "package-lock.json"), "v2");
    const r3 = mk2();
    await r3.start();
    await r3.stop();
    expect(fs.readFileSync(path.join(wt2, "runs"), "utf8")).toBe("xx");
    expect(r3.logs(0, "setup").lines.some((l) => /dependencies changed/.test(l.line))).toBe(true);
  });

  it("fails cleanly when a setup step fails", async () => {
    const p = validatePlan({ services: [{ name: "a", role: "api", cwd: ".", cmd: [node, "-e", "1"] }], setup: [{ name: "bad", cwd: ".", cmd: [node, "-e", "process.exit(2)"] }] });
    if (!("plan" in p)) throw new Error(p.error);
    const st = await mk(p.plan, "setup.state.json").start();
    expect(st.status).toBe("error");
    expect(st.error).toMatch(/setup bad failed \(exit 2\)/);
  });
});

describe("proc", () => {
  it("ring buffer keeps the last N lines", () => {
    const ring = new Ring(3);
    for (let i = 0; i < 5; i++) ring.push("s", "out", `l${i}`);
    expect(ring.lines.map((l) => l.line)).toEqual(["l2", "l3", "l4"]);
    expect(ring.since(4).map((l) => l.line)).toEqual(["l4"]);
  });

  it("times out readiness and stop kills a group that ignores SIGTERM", async () => {
    const ring = new Ring();
    const p = startProc({
      name: "stubborn",
      file: node,
      args: ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
      cwd: tmp,
      env: process.env,
      port: 1,
      ready: { path: "/", timeoutSec: 5 },
      ring,
      redact: (s) => s,
    });
    const r = await p.ready;
    expect(r.ok).toBe(false);
    const t0 = Date.now();
    await p.stop(500);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(groupAlive(p.pid)).toBe(false);
  });
});
