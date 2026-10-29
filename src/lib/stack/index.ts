import "server-only";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getFeature, getSettings } from "../store";
import { toolEnv } from "../sources/cli";
import { git, gitOk, prepareWorktree, worktreeDirFor, WORKTREES_DIR } from "../intake";
import type { StackPlanRecord, StackRole, StackState } from "../types";
import { getPlanRecord, hashOf, isPlanning, planStack, reservedPorts, STACKS_DIR, writeJson0600 } from "./planner";
import { groupAlive, killGroup, stopGroup } from "./proc";
import { readState, StackRun } from "./runner";

// Lambda's own copy of the developer's app — frontend + api + local queue — running from a lambda-owned
// worktree on free ports, so sketches / browser checks / builds never touch the developer's servers
// (3000 / 8000 stay theirs). One stack per worktree; plan approval gates everything.
//
// Process hygiene: services are spawned detached (own process groups), so the server's own group kill
// doesn't reach them — every exit path kills the recorded pgids explicitly: process "exit" here,
// electron/app/boot.cjs's watchdog (reads the state files), and a reap of orphans on the next start.

export { approvePlan, editPlan, getPlanRecord, isPlanning, planHash, PlanChangedError, planStack } from "./planner";
export { StackRun } from "./runner";

const IDLE_MS = 30 * 60 * 1000;

type G = {
  __lambdaStacks?: Map<string, StackRun>;
  __lambdaStackHooks?: boolean;
  __lambdaStackReap?: { at: number; run?: Promise<void> };
  __lambdaStackBusy?: (dir: string) => boolean; // read by intake's prepareWorktree (no import cycle)
};
const g = globalThis as G;
const stacks = (g.__lambdaStacks ??= new Map());

const stateFile = (key: string) => path.join(STACKS_DIR, `${key}.state.json`);
const keyOf = (worktree: string) => hashOf(worktree);
const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve) => execFile(cmd, args, { timeout: 3000 }, (err, out) => resolve(err ? "" : String(out).trim())));

// is some member of process group `pgid` running with its cwd inside `dir`? (guards against pid reuse)
async function groupInside(pgid: number, dir: string): Promise<boolean> {
  const pids = (await run("pgrep", ["-g", String(pgid)])).split("\n").filter((x) => /^\d+$/.test(x));
  for (const pid of pids.slice(0, 6)) {
    const cwd = (await run("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"])).split("\n").find((l) => l.startsWith("n"))?.slice(1);
    if (cwd && (cwd === dir || cwd.startsWith(dir + path.sep))) return true;
  }
  return false;
}

// ---------- process hooks (once per server process) ----------

if (!g.__lambdaStackHooks) {
  g.__lambdaStackHooks = true;
  // sync only: SIGTERM every group now, and a detached sh to SIGKILL stragglers after 5s
  process.on("exit", () => {
    const pgids = [...stacks.values()].flatMap((s) => s.pgids());
    if (!pgids.length) return;
    for (const p of pgids) killGroup(p, "SIGTERM");
    try {
      const list = pgids.map((p) => `-${p}`).join(" ");
      spawn("/bin/sh", ["-c", `sleep 5; kill -KILL -- ${list} 2>/dev/null`], { detached: true, stdio: "ignore" }).unref();
    } catch {}
  });
  setInterval(() => {
    for (const s of stacks.values())
      if (s.status !== "stopped" && Date.now() - s.lastUsedAt > IDLE_MS) void s.stop(undefined, "stopped after 30m idle").catch(() => undefined);
  }, 60_000).unref();
}

// intake must not move a checkout a stack is serving from (code swapping under next dev / uvicorn --reload)
g.__lambdaStackBusy = (dir: string) => {
  const wt = real(dir);
  const s = stacks.get(keyOf(wt));
  return (!!s && s.status !== "stopped") || !!foreignState(wt);
};

// every pgid a persisted state lists (services + a running setup step)
const statePgids = (st: StackState) => [...st.services.map((s) => s.pid ?? 0), st.setupPid ?? 0].filter((p) => p > 1);

// a state file nobody runs: its owner is gone, or it's ours but no StackRun holds it (module reloaded)
const ownerless = (st: StackState) =>
  st.ownerPid === process.pid ? !stacks.has(st.key) || stacks.get(st.key)!.status === "stopped" : !pidAlive(st.ownerPid);

// Kills the recorded groups of an ownerless state — only those whose processes still run inside that stack's
// worktree (guards against pid reuse) — and rewrites the state as stopped.
async function reapState(file: string, st: StackState, why: string): Promise<boolean> {
  let killed = false;
  await Promise.all(
    statePgids(st).map(async (pg) => {
      if (!groupAlive(pg) || !(await groupInside(pg, st.worktree))) return;
      killed = true;
      await stopGroup(pg, 4000);
    }),
  );
  writeJson0600(file, {
    ...st,
    status: "stopped",
    setupPid: undefined,
    services: st.services.map((s) => ({ ...s, pid: undefined, status: "stopped" })),
    ...(killed ? { error: why } : {}),
  });
  return killed;
}

// Orphans of a server that died hard. Throttled (not memoized forever): another lambda's owner can die later.
// Stacks of a live lambda process are left alone.
export function reapOrphans(force = false): Promise<void> {
  const r = (g.__lambdaStackReap ??= { at: 0 });
  if (r.run) return r.run;
  if (!force && Date.now() - r.at < 5000) return Promise.resolve();
  r.at = Date.now();
  const run = (async () => {
    let files: string[] = [];
    try {
      files = fs.readdirSync(STACKS_DIR).filter((f) => f.endsWith(".state.json"));
    } catch {
      return;
    }
    for (const f of files) {
      const st = readState(path.join(STACKS_DIR, f));
      if (!st || !ownerless(st)) continue;
      if (st.status === "stopped" && !statePgids(st).length) continue;
      await reapState(path.join(STACKS_DIR, f), st, "cleaned up after lambda restarted");
    }
  })();
  r.run = run;
  run.finally(() => (r.run = undefined)).catch(() => undefined);
  return run;
}

// ---------- lookup ----------

// the persisted state of a stack another live lambda process owns (installed app vs dev server)
function foreignState(worktree: string): StackState | null {
  const st = readState(stateFile(keyOf(worktree)));
  if (!st || st.ownerPid === process.pid || !pidAlive(st.ownerPid)) return null;
  if (!st.services.some((s) => s.pid && groupAlive(s.pid))) return null;
  return { ...st, foreign: true };
}

// A state file nobody runs is reported as stopped (never "running" with buttons that do nothing); the
// GET routes reap its leftovers first.
export function stackState(worktree: string): StackState | null {
  const s = stacks.get(keyOf(real(worktree)));
  if (s) return s.state();
  const foreign = foreignState(real(worktree));
  if (foreign) return foreign;
  const st = readState(stateFile(keyOf(real(worktree))));
  if (!st || st.status === "stopped") return st;
  const leftovers = statePgids(st).some((p) => groupAlive(p));
  return {
    ...st,
    status: "stopped",
    setupPid: undefined,
    services: st.services.map((x) => ({ ...x, pid: undefined, status: "stopped" })),
    error: leftovers ? "left over from a lambda that exited — cleaning up" : "lambda exited while it ran",
  };
}

// marks the stack as in use (a feature page / the stack sheet is looking at it)
export function touchStack(worktree: string, featureId?: string) {
  const s = stacks.get(keyOf(real(worktree)));
  if (s && s.status !== "stopped") s.touch(featureId);
}

export function stackLogs(worktree: string, since = 0, service?: string) {
  const s = stacks.get(keyOf(real(worktree)));
  if (!s) return { lines: [], last: 0 };
  s.touch();
  return s.logs(since, service);
}

// ---------- run ----------

export class StackNotApprovedError extends Error {
  constructor(msg = "the local stack plan isn't approved yet") {
    super(msg);
  }
}

const samePlan = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Ensures the approved plan runs in `worktree`. Resolves once every service is ready (or failed).
// A stack owned by another live lambda process is reported, never restarted from here.
export async function ensureStack(
  worktree: string,
  record: StackPlanRecord | null,
  opts: { featureId?: string; ref?: string; services?: string[] } = {},
): Promise<StackState> {
  if (!record?.plan || !record.approved) throw new StackNotApprovedError();
  const wt = real(worktree);
  const key = keyOf(wt);
  if (!stacks.has(key)) await reapOrphans(true); // a dead lambda's groups may still hold this stack's ports
  let s = stacks.get(key);
  // a stopped run made by an older copy of the runner (dev hot reload) is replaced, so fixes take effect
  if (s && !(s instanceof StackRun) && s.status === "stopped") {
    stacks.delete(key);
    s = undefined;
  }
  if (s && !samePlan(s.ctx.plan, record.plan)) {
    await s.stop(); // the plan changed under a running stack: run the new one
    stacks.delete(key);
    s = undefined;
  }
  if (!s) {
    const foreign = foreignState(wt);
    if (foreign) return foreign;
    s = new StackRun({
      key,
      worktree: wt,
      repoPath: record.repoPath,
      ref: opts.ref ?? "main",
      plan: record.plan,
      stateFile: stateFile(key),
      baseEnv: toolEnv(),
      avoidPorts: () => [...reservedPorts(), ...claimedPorts(key)],
      write: writeJson0600,
    });
    stacks.set(key, s);
  }
  s.touch(opts.featureId);
  if (opts.services?.length) {
    for (const name of opts.services) await s.startService(name);
    return s.state();
  }
  if (s.status === "ready" || s.status === "partial") return s.state();
  return s.start();
}

export async function stopStack(worktree: string, service?: string): Promise<StackState | null> {
  const wt = real(worktree);
  const s = stacks.get(keyOf(wt));
  if (s) return s.stop(service);
  // no StackRun here: a stack whose lambda died still has its groups recorded — kill them
  const file = stateFile(keyOf(wt));
  const st = readState(file);
  if (st && ownerless(st)) await reapState(file, st, "stopped (left over from a lambda that exited)");
  return stackState(wt);
}

// ports held by every other live stack — in this process and in the other lambda's state files
function claimedPorts(exceptKey: string): number[] {
  const out = [...stacks.values()]
    .filter((s) => s.ctx.key !== exceptKey)
    .flatMap((s) =>
      // an instance from before a dev hot reload may lack claimedPorts
      typeof (s as Partial<StackRun>).claimedPorts === "function" ? s.claimedPorts() : (s as StackRun).state().services.flatMap((x) => [x.port ?? 0, ...Object.values(x.extraPorts ?? {})]),
    );
  try {
    for (const f of fs.readdirSync(STACKS_DIR).filter((n) => n.endsWith(".state.json"))) {
      const st = readState(path.join(STACKS_DIR, f));
      if (!st || st.key === exceptKey || st.status === "stopped" || ownerless(st) || st.ownerPid === process.pid) continue;
      for (const x of st.services) out.push(x.port ?? 0, ...Object.values(x.extraPorts ?? {}));
    }
  } catch {}
  return out.filter(Boolean);
}

export async function restartStack(worktree: string, record: StackPlanRecord | null, service?: string): Promise<StackState> {
  const s = stacks.get(keyOf(real(worktree)));
  if (!s || (record?.plan && !samePlan(s.ctx.plan, record.plan))) return ensureStack(worktree, record, service ? { services: [service] } : {});
  s.touch();
  return s.restart(service);
}

// ---------- worktrees ----------

// lambda's shared checkout of the configured repo's base branch (understand-mode intake reads it too).
// Polled: never fetches, never moves it — only creates it (at the last known base tip) when it's missing.
export async function mainWorktree(repoPath = getSettings().repoPath): Promise<string> {
  const wt = await prepareWorktree(repoPath, false);
  if (!wt.dir) throw new Error("reason" in wt ? wt.reason : "no repo");
  return wt.dir;
}

const BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,120}$/;

// a lambda-owned detached checkout of `branch` (for the build flow); moved to the branch tip only while
// no stack runs in it. The developer's checkout is never touched.
export async function branchWorktree(repoPath: string, branch: string): Promise<string> {
  if (!BRANCH.test(branch)) throw new Error("bad branch name");
  const top = await git(["rev-parse", "--show-toplevel"], real(repoPath));
  let ref = `refs/heads/${branch}`;
  if (!(await gitOk(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], top))) {
    ref = `refs/remotes/origin/${branch}`;
    if (!(await gitOk(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], top))) throw new Error(`no branch ${branch}`);
  }
  const sha = await git(["rev-parse", `${ref}^{commit}`], top);
  const dir = `${worktreeDirFor(top)}-${hashOf(branch).slice(0, 6)}`;
  const valid = fs.existsSync(path.join(dir, ".git")) && (await gitOk(["rev-parse", "--show-toplevel"], dir)) === real(dir);
  if (!valid) {
    if (path.dirname(dir) === WORKTREES_DIR) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(WORKTREES_DIR, { recursive: true });
    await git(["worktree", "add", "-f", "--detach", dir, sha], top);
  } else if ((await gitOk(["rev-parse", "HEAD"], dir)) !== sha) {
    const st = stacks.get(keyOf(real(dir)));
    if (!st || st.status === "stopped") await git(["checkout", "--detach", "--force", sha], dir);
  }
  return real(dir);
}

// For the build flow: the feature's stack on main (default) or on a branch's own worktree.
export async function ensureStackFor(featureId: string, ref: "main" | string = "main"): Promise<StackState> {
  const repo = getSettings().repoPath;
  if (!repo) throw new Error("no repo configured");
  const record = getPlanRecord(repo);
  const wt = ref === "main" ? await mainWorktree(repo) : await branchWorktree(repo, ref);
  return ensureStack(wt, record, { featureId, ref });
}

// Intake's first turn: start the stack in the background when a plan is approved; with no plan at all,
// plan one in the background. Always on the shared checkout (see featureWorktree). Never blocks, never throws.
export function kickStack(featureId: string, repoPath: string): void {
  if (!repoPath) return;
  const record = getPlanRecord(repoPath);
  const go = record?.plan && record.approved;
  if (!go && (record || isPlanning(repoPath))) return;
  void mainWorktree(repoPath)
    .then((worktree): Promise<unknown> => (go ? ensureStack(worktree, record, { featureId }) : planStack(repoPath, worktree)))
    .catch(() => undefined);
}

// Where a feature's stack runs: the shared checkout, for build features too. A build feature's own pinned
// checkout is for reading; a stack per feature would mean a full setup + new ports each, and the stack
// sheet's stop / restart / logs only ever reach the shared one. Sketches + browser checks capture the base.
export async function featureWorktree(featureId: string): Promise<string | null> {
  if (!getFeature(featureId)) return null;
  try {
    return real(await mainWorktree());
  } catch {
    return null;
  }
}

// ---------- urls ----------

// Base URL of a running service of the main-worktree stack for the configured repo (ready only), or null.
export async function stackUrl(role: StackRole, repoPath = getSettings().repoPath): Promise<string | null> {
  if (!repoPath) return null;
  const dir = real(worktreeDirFor(real(repoPath)));
  const s = stacks.get(keyOf(dir));
  if (s) {
    const u = s.urlOf(role);
    if (u) s.touch();
    return u;
  }
  const f = foreignState(dir);
  return f?.services.find((x) => x.role === role && x.status === "ready" && x.url)?.url ?? null;
}

export class StackDownError extends Error {}

// Where sketches / browser checks point. With an approved plan it's lambda's own frontend, never the
// developer's server: start it (or wait for it, bounded) and throw StackDownError when it isn't up.
// Without an approved plan, the configured app url.
export async function appBase(settings = getSettings(), waitMs = 120_000): Promise<string> {
  const now = await stackUrl("frontend", settings.repoPath).catch(() => null);
  if (now) return now;
  const record = settings.repoPath ? getPlanRecord(settings.repoPath) : null;
  if (!record?.plan || !record.approved) return settings.frontendUrl;
  let wt: string | null = null;
  const run = mainWorktree(settings.repoPath).then((dir) => {
    wt = dir;
    return ensureStack(dir, record);
  });
  const res = await Promise.race([
    run.then(
      (st) => ({ st }),
      (e: unknown) => ({ e }),
    ),
    new Promise<null>((r) => setTimeout(() => r(null), waitMs).unref?.()),
  ]);
  const url = await stackUrl("frontend", settings.repoPath).catch(() => null);
  if (url) return url;
  if (res && "e" in res) throw new StackDownError(`lambda's app couldn't start: ${res.e instanceof Error ? res.e.message : String(res.e)}`.slice(0, 200));
  const st = res?.st ?? (wt ? stackState(wt) : null);
  const front = st?.services.find((x) => x.role === "frontend");
  if (!res || st?.status === "setup" || st?.status === "starting" || front?.status === "starting") throw new StackDownError("lambda's app is still starting — try again in a moment");
  throw new StackDownError(`lambda's app isn't up${front?.error ? ` (frontend: ${front.error})` : st?.error ? ` (${st.error})` : ""} — check the local stack`.slice(0, 200));
}
