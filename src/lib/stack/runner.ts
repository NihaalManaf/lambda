import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StackPlan, StackService, StackServiceState, StackState } from "../types";
import { copyEnvFiles, envFileSecrets, redactor, serviceEnv, unwiredLocalRefs } from "./env";
import { commandFor, resolvePlaceholders, urlFor, type PortMap, type Vars } from "./plan";
import { allocatePorts } from "./ports";
import { groupAlive, Ring, RING_MAX, startProc, stopGroup, type LogLine, type Proc } from "./proc";

// One stack = one approved plan running in one lambda-owned worktree: env files copied in, setup steps,
// every non-optional service on its own free port, readiness, crash tracking, stop / restart. State is
// persisted (ports, pgids, status) so a crashed server's orphans can be found and reaped later.

const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

export type StackCtx = {
  key: string;
  worktree: string; // lambda's checkout the services run in
  repoPath: string; // the developer's checkout (read-only: env files, venvs, node_modules)
  ref: string; // "main" or a branch name
  plan: StackPlan;
  stateFile: string;
  baseEnv: NodeJS.ProcessEnv; // widened PATH (toolEnv)
  avoidPorts?: number[] | (() => number[]); // a function: re-read at every allocation (other live stacks' ports)
  write?: (file: string, data: unknown) => void;
  readyTimeoutSec?: number;
};

type Svc = { spec: StackService; state: StackServiceState; proc?: Proc; ring: Ring };

const nowIso = () => new Date().toISOString();

const within = (root: string, p: string) => {
  const rel = path.relative(root, p);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
};

export function readState(file: string): StackState | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as StackState;
  } catch {
    return null;
  }
}

export class StackRun {
  readonly svcs = new Map<string, Svc>();
  private counter = { n: 0 };
  readonly setupRing = new Ring(RING_MAX, this.counter);
  private setupProc?: Proc;
  status: StackState["status"] = "stopped";
  error?: string;
  features = new Set<string>();
  lastUsedAt = Date.now();
  private busy?: Promise<StackState>;
  private stopping = false;
  private redact: (s: string) => string = (s) => s;
  private ports: PortMap = {};

  constructor(public ctx: StackCtx) {
    const prev = readState(ctx.stateFile);
    for (const spec of ctx.plan.services) {
      const p = prev?.services.find((s) => s.name === spec.name);
      this.svcs.set(spec.name, {
        spec,
        ring: new Ring(RING_MAX, this.counter),
        state: { name: spec.name, role: spec.role, status: "stopped", ...(p?.port ? { port: p.port } : {}), ...(p?.extraPorts ? { extraPorts: p.extraPorts } : {}) },
      });
    }
  }

  // ---------- state ----------

  state(): StackState {
    return {
      key: this.ctx.key,
      worktree: this.ctx.worktree,
      repoPath: this.ctx.repoPath,
      ownerPid: process.pid,
      status: this.status,
      services: [...this.svcs.values()].map((s) => ({ ...s.state })),
      features: [...this.features],
      lastUsedAt: new Date(this.lastUsedAt).toISOString(),
      ...(this.setupProc && groupAlive(this.setupProc.pid) ? { setupPid: this.setupProc.pid } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  private persist() {
    const write =
      this.ctx.write ??
      ((file: string, data: unknown) => {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, file);
      });
    try {
      write(this.ctx.stateFile, { ...this.state(), ref: this.ctx.ref });
    } catch {
      /* best effort */
    }
  }

  // every process group this stack still owns (for exit / watchdog cleanup) — by group liveness, not the
  // leader's: children that outlived their leader still hold ports
  pgids(): number[] {
    const ids = [...[...this.svcs.values()].map((s) => s.proc?.pid ?? 0), this.setupProc?.pid ?? 0];
    return [...new Set(ids)].filter((p) => p > 1 && groupAlive(p));
  }

  // ports this stack holds or is about to bind (other stacks avoid them)
  claimedPorts(): number[] {
    if (this.status === "stopped") return [];
    return [...this.svcs.values()].flatMap((s) => [s.state.port ?? 0, ...Object.values(s.state.extraPorts ?? {})]).filter(Boolean);
  }

  touch(featureId?: string) {
    this.lastUsedAt = Date.now();
    if (featureId) this.features.add(featureId);
  }

  logs(since = 0, service?: string): { lines: LogLine[]; last: number } {
    const rings = service === "setup" ? [this.setupRing] : service ? [this.svcs.get(service)?.ring].filter((r): r is Ring => !!r) : [this.setupRing, ...[...this.svcs.values()].map((s) => s.ring)];
    const lines = rings.flatMap((r) => r.since(since)).sort((a, b) => a.seq - b.seq);
    return { lines, last: this.counter.n };
  }

  urlOf(role: StackService["role"]): string | null {
    const s = [...this.svcs.values()].find((x) => x.spec.role === role && x.state.status === "ready" && x.state.url);
    return s?.state.url ?? null;
  }

  private recompute() {
    if (this.status === "setup" || this.stopping) return;
    const want = [...this.svcs.values()].filter((s) => !s.spec.optional || s.proc);
    const st = want.map((s) => s.state.status);
    if (!st.length || st.every((x) => x === "stopped")) this.status = "stopped";
    else if (st.some((x) => x === "starting")) this.status = "starting";
    else if (st.every((x) => x === "ready")) this.status = "ready";
    else if (st.some((x) => x === "ready")) this.status = "partial";
    else this.status = "error";
  }

  // ---------- start ----------

  private vars(): Vars {
    return { repo: this.ctx.repoPath, worktree: this.ctx.worktree, ports: this.ports };
  }

  private async allocate() {
    const specs = [...this.svcs.values()];
    const want: { name: string; extra?: string; pref?: number }[] = [];
    for (const s of specs) {
      if (s.spec.port) want.push({ name: s.spec.name, pref: s.state.port });
      for (const e of s.spec.extraPorts ?? []) want.push({ name: s.spec.name, extra: e, pref: s.state.extraPorts?.[e] });
    }
    // ports of services that are running keep theirs
    const running = new Set(specs.filter((s) => s.proc?.alive()).map((s) => s.spec.name));
    const free = want.filter((w) => !running.has(w.name));
    const held = want.filter((w) => running.has(w.name)).map((w) => w.pref!).filter(Boolean);
    const avoid = typeof this.ctx.avoidPorts === "function" ? this.ctx.avoidPorts() : (this.ctx.avoidPorts ?? []);
    const got = await allocatePorts(free.length, { preferred: free.map((w) => w.pref), avoid: [...avoid, ...held] });
    free.forEach((w, i) => {
      const s = this.svcs.get(w.name)!;
      if (w.extra) s.state.extraPorts = { ...s.state.extraPorts, [w.extra]: got[i] };
      else {
        s.state.port = got[i];
        s.state.url = urlFor(got[i]);
      }
    });
    this.ports = Object.fromEntries(specs.map((s) => [s.spec.name, { port: s.state.port, extra: s.state.extraPorts }]));
  }

  private dirOf(cwd: string) {
    const d = path.resolve(this.ctx.worktree, cwd || ".");
    if (!within(this.ctx.worktree, d)) throw new Error(`cwd ${cwd} is outside the checkout`);
    return d;
  }

  // ---------- setup stamps ----------
  // A skipIf step (e.g. cloning node_modules) ran against some lockfiles; when they change (main moved, the
  // developer reinstalled) the copy is stale. The stamp = the step + the lockfiles in its cwd, in both checkouts.

  private stampFile() {
    return this.ctx.stateFile.replace(/(\.state)?\.json$/, "") + ".setup.json";
  }

  private readStamps(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.stampFile(), "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private writeStamp(name: string, stamp: string) {
    try {
      const file = this.stampFile();
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ ...this.readStamps(), [name]: stamp }), { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  private stampOf(step: StackPlan["setup"][number]): string {
    const h = crypto.createHash("sha1").update(JSON.stringify(step));
    const LOCKS = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "npm-shrinkwrap.json", "requirements.txt", "poetry.lock", "uv.lock", "Pipfile.lock", "Gemfile.lock"];
    for (const root of [this.ctx.worktree, this.ctx.repoPath]) {
      const dir = path.resolve(root, step.cwd || ".");
      for (const f of LOCKS) {
        try {
          h.update(f).update(fs.readFileSync(path.join(dir, f)));
        } catch {}
      }
    }
    return h.digest("hex").slice(0, 16);
  }

  // removable = inside lambda's checkout and not a tracked file (never delete repo content)
  private removable(cwd: string, target: string): boolean {
    if (!within(this.ctx.worktree, target) || target === this.ctx.worktree) return false;
    try {
      const tracked = execFileSync("git", ["ls-files", "--", path.relative(cwd, target)], { cwd, encoding: "utf8", timeout: 5000 });
      return !tracked.trim();
    } catch {
      return false;
    }
  }

  private async runSetup() {
    const stamps = this.readStamps();
    for (const step of this.ctx.plan.setup) {
      if (this.stopping) throw new Error("stopped");
      const cwd = this.dirOf(step.cwd);
      const stamp = this.stampOf(step);
      if (step.skipIf) {
        const target = path.resolve(cwd, step.skipIf);
        if (fs.existsSync(target)) {
          if (!stamps[step.name] || stamps[step.name] === stamp) {
            if (!stamps[step.name]) this.writeStamp(step.name, stamp); // adopt what's there
            this.setupRing.push("setup", "sys", `${step.name}: skipped (${step.skipIf} exists)`);
            continue;
          }
          if (!this.removable(cwd, target)) {
            this.setupRing.push("setup", "sys", `${step.name}: dependencies changed, but ${step.skipIf} can't be refreshed safely — skipped`);
            continue;
          }
          this.setupRing.push("setup", "sys", `${step.name}: dependencies changed since the last copy — redoing it`);
          fs.rmSync(target, { recursive: true, force: true });
        }
      }
      fs.mkdirSync(cwd, { recursive: true });
      const { file, args } = commandFor(step, this.vars());
      this.setupRing.push("setup", "sys", `${step.name}: running`);
      const proc = startProc({ name: "setup", file, args, cwd, env: serviceEnv(this.ctx.baseEnv, {}), ring: this.setupRing, redact: this.redact });
      this.setupProc = proc;
      this.persist(); // the setup pgid goes into the state file for the reaper / watchdog
      const timer = setTimeout(() => void proc.stop(2000), SETUP_TIMEOUT_MS);
      const code = await proc.exited;
      clearTimeout(timer);
      this.setupProc = undefined;
      if (groupAlive(proc.pid)) await stopGroup(proc.pid, 2000); // nothing it forked outlives the step
      if (code !== 0) throw new Error(`setup ${step.name} failed (exit ${code})`);
      this.writeStamp(step.name, stamp);
    }
  }

  private envFor(s: Svc): NodeJS.ProcessEnv {
    const v = this.vars();
    const extra: Record<string, string> = {};
    if (s.spec.port?.env && s.state.port) extra[s.spec.port.env] = String(s.state.port);
    for (const [k, val] of Object.entries(this.ctx.plan.env[s.spec.name] ?? {})) extra[k] = resolvePlaceholders(val, v, s.spec.name);
    return serviceEnv(this.ctx.baseEnv, extra);
  }

  private launch(s: Svc): Proc {
    const cwd = this.dirOf(s.spec.cwd);
    const { file, args } = commandFor(s.spec, this.vars(), s.spec.name, s.state.port);
    s.ring.push(s.spec.name, "sys", `starting on ${s.state.port ? `:${s.state.port}` : "(no port)"}`);
    const proc = startProc({
      name: s.spec.name,
      file,
      args,
      cwd,
      env: this.envFor(s),
      port: s.state.port,
      ready: s.spec.ready,
      ring: s.ring,
      redact: this.redact,
      defaultTimeoutSec: this.ctx.readyTimeoutSec ?? (s.spec.role === "frontend" ? 240 : 180),
    });
    s.proc = proc;
    Object.assign(s.state, { pid: proc.pid, status: "starting", startedAt: nowIso(), exitCode: undefined, error: undefined, readyAt: undefined });
    proc.exited.then(async (code) => {
      if (s.proc !== proc) return;
      s.state.exitCode = code;
      if (s.state.status !== "stopped") {
        s.state.status = "crashed";
        s.state.error = `exited (${code})`;
      }
      this.recompute();
      this.persist(); // pid stays recorded until the whole group is gone
      // the leader is gone; whatever it started (next-server, the qstash binary, uvicorn workers) goes too
      if (groupAlive(proc.pid)) await stopGroup(proc.pid, 3000);
      if (s.proc === proc) s.state.pid = undefined;
      this.persist();
    });
    proc.ready.then((r) => {
      if (s.proc !== proc || s.state.status !== "starting") return;
      if (r.ok) Object.assign(s.state, { status: "ready", readyAt: nowIso() });
      else {
        Object.assign(s.state, { status: "error", error: r.error });
        void proc.stop(); // half-started: free the port
      }
      this.recompute();
      this.persist();
    });
    return proc;
  }

  // Full start (setup + every non-optional service, plus `only` names). Joins an in-flight start.
  start(only?: string[]): Promise<StackState> {
    if (this.busy) return this.busy;
    this.lastUsedAt = Date.now();
    const run = (async () => {
      this.stopping = false;
      this.error = undefined;
      try {
        this.status = "setup";
        this.persist();
        const copied = copyEnvFiles(this.ctx.repoPath, this.ctx.worktree, this.ctx.plan.envFiles);
        const missing = copied.filter((c) => c.status === "missing").map((c) => c.file);
        if (missing.length) this.setupRing.push("setup", "sys", `env files not found in your checkout: ${missing.join(", ")}`);
        const removed = copied.filter((c) => c.status === "removed").map((c) => c.file);
        if (removed.length) this.setupRing.push("setup", "sys", `env files gone from your checkout, removed lambda's copy: ${removed.join(", ")}`);
        this.redact = redactor(envFileSecrets(this.ctx.repoPath, this.ctx.plan.envFiles));
        await this.allocate();
        const own = Object.values(this.ports).flatMap((p) => [p.port ?? 0, ...Object.values(p.extra ?? {})]);
        for (const r of unwiredLocalRefs(this.ctx.repoPath, this.ctx.plan, own))
          this.setupRing.push("setup", "sys", `${r.file}: ${r.key} still points at your :${r.port} (the plan doesn't override it)`);
        await this.runSetup();
        if (this.stopping) throw new Error("stopped");
        this.status = "starting";
        const pick = [...this.svcs.values()].filter((s) => (!s.spec.optional || only?.includes(s.spec.name)) && !s.proc?.alive());
        for (const s of pick) this.launch(s);
        this.recompute();
        this.persist();
        await Promise.all(pick.map((s) => s.proc!.ready));
        await new Promise((r) => setTimeout(r, 0)); // let the ready handlers above settle state first
        this.recompute();
      } catch (e) {
        this.error = e instanceof Error ? e.message.slice(0, 300) : String(e);
        this.status = this.stopping ? "stopped" : "error";
      }
      this.persist();
      return this.state();
    })();
    this.busy = run;
    run.finally(() => (this.busy = undefined)).catch(() => undefined);
    return run;
  }

  async startService(name: string): Promise<StackState> {
    const s = this.svcs.get(name);
    if (!s) throw new Error(`no service "${name}"`);
    if (s.proc?.alive()) return this.state();
    if (this.status === "stopped" || !this.ports[name]) return this.start([name]);
    this.launch(s);
    this.recompute();
    this.persist();
    await s.proc!.ready;
    await new Promise((r) => setTimeout(r, 0));
    return this.state();
  }

  // ---------- stop ----------

  async stop(name?: string, reason?: string): Promise<StackState> {
    if (name) {
      const s = this.svcs.get(name);
      if (!s) throw new Error(`no service "${name}"`);
      s.state.status = "stopped";
      await s.proc?.stop();
      s.state.pid = undefined;
      this.recompute();
      this.persist();
      return this.state();
    }
    this.stopping = true;
    for (const s of this.svcs.values()) s.state.status = "stopped";
    await Promise.all([this.setupProc?.stop(2000), ...[...this.svcs.values()].map((s) => s.proc?.stop())]);
    for (const s of this.svcs.values()) s.state.pid = undefined;
    await this.busy?.catch(() => undefined);
    this.status = "stopped";
    this.stopping = false;
    if (reason) this.error = reason;
    this.persist();
    return this.state();
  }

  async restart(name?: string): Promise<StackState> {
    if (name) {
      await this.stop(name);
      return this.startService(name);
    }
    await this.stop();
    return this.start();
  }
}
