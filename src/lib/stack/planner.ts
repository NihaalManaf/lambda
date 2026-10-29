import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseStreamLine } from "../intake-parse";
import { toolEnv } from "../sources/cli";
import { DATA_DIR, getSettings, now } from "../store";
import type { StackPlan, StackPlanRecord } from "../types";
import { localhostKeys } from "./env";
import { parsePlanBlock, RESERVED_PORTS, STACK_PROMPT, validatePlan } from "./plan";

// planStack: ONE Claude Code session (plan mode, read-only tools, sandboxed like intake) reads the repo
// and writes a lambda-stack plan. Stored per repo in DATA_DIR/stacks/<hash>.json, unapproved until the
// developer approves it — nothing runs from a plan nobody approved.

export const STACKS_DIR = path.join(DATA_DIR, "stacks");
const PLAN_TIMEOUT_MS = 6 * 60 * 1000;
const PLAN_MAX_TURNS = 40;
const PLAN_BUDGET_USD = 2;

export const hashOf = (p: string) => crypto.createHash("sha1").update(p).digest("hex").slice(0, 10);
const realRepo = (repo: string) => {
  try {
    return fs.realpathSync(repo);
  } catch {
    return path.resolve(repo);
  }
};
const planFile = (repo: string) => path.join(STACKS_DIR, `${hashOf(realRepo(repo))}.json`);

export function writeJson0600(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// identity of a plan's content: approval is bound to it
export const planHash = (plan: StackPlan) => crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 16);

// approval only counts for the exact plan that was approved (a plan swapped under an approval is unapproved)
export function getPlanRecord(repo: string): StackPlanRecord | null {
  if (!repo) return null;
  try {
    const r = JSON.parse(fs.readFileSync(planFile(repo), "utf8")) as StackPlanRecord;
    if (r.approved && (!r.plan || r.approvedHash !== planHash(r.plan))) r.approved = false;
    return r;
  } catch {
    return null;
  }
}

export class PlanChangedError extends Error {
  constructor() {
    super("plan changed since you looked — review it again");
  }
}

function savePlanRecord(repo: string, patch: Partial<StackPlanRecord>): StackPlanRecord {
  const cur = getPlanRecord(repo);
  const next: StackPlanRecord = { repoPath: realRepo(repo), approved: false, createdAt: now(), ...cur, ...patch, updatedAt: now() };
  if (patch.plan) delete next.planError;
  writeJson0600(planFile(repo), next);
  return next;
}

// the developer's usual ports + whatever their configured app url uses
export function reservedPorts(): number[] {
  const out = [...RESERVED_PORTS];
  try {
    const u = new URL(getSettings().frontendUrl);
    const p = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    if (p && !out.includes(p)) out.push(p);
  } catch {}
  return out;
}

// a developer edit: validated, stored, and unapproved again (they approve what they'll run)
export function editPlan(repo: string, raw: unknown): StackPlanRecord {
  const v = validatePlan(raw, reservedPorts());
  if ("error" in v) throw new Error(v.error);
  return savePlanRecord(repo, { plan: v.plan, approved: false, source: "edited" });
}

// hash: planHash of the plan the developer was shown — required to approve, refused when it's not the stored one
export function approvePlan(repo: string, approved = true, hash?: string): StackPlanRecord {
  const cur = getPlanRecord(repo);
  if (!cur?.plan) throw new Error("no stack plan to approve yet");
  if (!approved) return savePlanRecord(repo, { approved: false, approvedHash: undefined });
  if (!hash) throw new Error("planHash must be sent with an approval");
  if (hash !== planHash(cur.plan)) throw new PlanChangedError();
  return savePlanRecord(repo, { approved: true, approvedHash: hash });
}

// ---------- the session ----------

// gitignored things that exist in the developer's checkout, names only (the worktree has none of them)
export function checkoutInventory(repo: string): string[] {
  const out: string[] = [];
  const want = (n: string) => n === "node_modules" || n === "venv" || n === ".venv" || n === "env" || /^\.env(\..+)?$/.test(n);
  const scan = (dir: string, rel: string, depth: number) => {
    let ents: fs.Dirent[] = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (want(e.name)) out.push(e.isDirectory() ? `${r}/` : r);
      else if (e.isDirectory() && depth < 2 && !e.name.startsWith(".") && !["dist", "build", "out", "__pycache__"].includes(e.name))
        scan(path.join(dir, e.name), r, depth + 1);
    }
  };
  scan(repo, "", 0);
  return out.slice(0, 60);
}

export function planArgs(prompt: string, session: { id: string; resume: boolean }): string[] {
  return [
    "-p",
    prompt.startsWith("-") ? ` ${prompt}` : prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "plan",
    "--append-system-prompt", STACK_PROMPT,
    "--max-turns", String(PLAN_MAX_TURNS),
    "--max-budget-usd", String(PLAN_BUDGET_USD),
    ...(session.resume ? ["--resume", session.id] : ["--session-id", session.id]),
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify({ mcpServers: {} }),
    "--setting-sources", "user",
    "--tools", "Read", "Grep", "Glob",
  ];
}

type G = { __lambdaStackPlanning?: Map<string, Promise<StackPlanRecord>>; __lambdaStackPlanKids?: Set<ChildProcess>; __lambdaStackPlanReaper?: boolean };
const g = globalThis as G;
const planning = (g.__lambdaStackPlanning ??= new Map());
const kids = (g.__lambdaStackPlanKids ??= new Set());
if (!g.__lambdaStackPlanReaper) {
  g.__lambdaStackPlanReaper = true;
  process.on("exit", () => {
    for (const c of kids) c.kill("SIGTERM");
  });
}

export const isPlanning = (repo: string) => planning.has(realRepo(repo));

function runSession(cwd: string, prompt: string, session: { id: string; resume: boolean }): Promise<{ ok: boolean; all: string; error?: string }> {
  return new Promise((resolve) => {
    const env = toolEnv();
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    let child: ChildProcess;
    try {
      child = spawn("claude", planArgs(prompt, session), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, all: "", error: `could not start claude: ${e instanceof Error ? e.message : e}` });
    }
    kids.add(child);
    const texts: string[] = [];
    let result: { ok: boolean; error?: string; text: string } | null = null;
    let buf = "";
    let stderr = "";
    const onLine = (line: string) => {
      for (const ev of parseStreamLine(line, cwd)) {
        if (ev.kind === "assistant" && texts[texts.length - 1] !== ev.text) texts.push(ev.text);
        else if (ev.kind === "result" && !result) result = { ok: ev.ok, text: ev.text, ...(ev.error ? { error: ev.error } : {}) };
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      buf += c;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      lines.forEach(onLine);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => (stderr = (stderr + c).slice(-2000)));
    const timer = setTimeout(() => {
      result = { ok: false, text: "", error: "planning took too long" };
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 4000).unref();
    }, PLAN_TIMEOUT_MS);
    let settled = false;
    const done = (code: number | null, err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kids.delete(child);
      if (buf.trim()) onLine(buf);
      const r = result as { ok: boolean; error?: string; text: string } | null;
      const all = [...texts, r?.text ?? ""].filter(Boolean).join("\n\n");
      if (err) return resolve({ ok: false, all, error: `could not start claude: ${err.message}` });
      if (r) return resolve({ ok: r.ok, all, ...(r.error ? { error: r.error.slice(0, 200) } : {}) });
      resolve({ ok: false, all, error: stderr.trim().split("\n").pop()?.slice(0, 160) || `claude exited (${code ?? "killed"})` });
    };
    child.on("error", (e) => done(null, e));
    child.on("close", (code) => done(code));
  });
}

// env-file keys whose value points at a localhost port: names + ports only, so the plan overrides each one
function localRefsHint(repo: string, inventory: string[]): string[] {
  const files = inventory.filter((x) => !x.endsWith("/") && /(^|\/)\.env(\.(?!example|sample|template)[^/]+)?$/.test(x));
  const refs = localhostKeys(repo, files);
  if (!refs.length) return [];
  return [
    `env-file keys that point at the developer's localhost servers — each would make lambda's copy call THEIR servers. override every one the services read with a placeholder in "env" (e.g. \${url:api}):\n${refs
      .slice(0, 30)
      .map((r) => `- ${r.file}: ${r.key} (→ :${r.port})`)
      .join("\n")}`,
  ];
}

async function headSha(dir: string): Promise<string | undefined> {
  try {
    const head = fs.readFileSync(path.join(dir, ".git"), "utf8").match(/gitdir:\s*(.+)/)?.[1]?.trim();
    const h = head ? fs.readFileSync(path.join(head, "HEAD"), "utf8").trim() : "";
    return /^[0-9a-f]{40}$/.test(h) ? h : undefined;
  } catch {
    return undefined;
  }
}

// Runs (or joins) the planning session for this repo. Resolves with the stored record (plan or planError).
export function planStack(repoPath: string, worktree: string): Promise<StackPlanRecord> {
  const repo = realRepo(repoPath);
  const inflight = planning.get(repo);
  if (inflight) return inflight;
  const run = (async () => {
    const reserved = reservedPorts();
    const inventory = checkoutInventory(repo);
    const prompt = [
      `plan the local stack for this repo. this checkout: ${worktree}. the developer's checkout (\${repo}): ${repo}.`,
      inventory.length
        ? `gitignored things present in the developer's checkout (reuse them; contents are private, don't ask for them):\n${inventory.map((x) => `- ${x}`).join("\n")}`
        : "the developer's checkout has no node_modules / venv / .env files at the top two levels.",
      `ports the developer uses (never use them): ${reserved.join(", ")}.`,
      ...localRefsHint(repo, inventory),
    ].join("\n\n");
    const session = { id: crypto.randomUUID(), resume: false };
    let out = await runSession(worktree, prompt, session);
    let parsed = parsePlanBlock(out.all, reserved);
    if ("error" in parsed && out.ok) {
      // one correction round in the same session
      const fix = await runSession(worktree, `your lambda-stack block didn't validate: ${parsed.error}. re-emit exactly one corrected lambda-stack block, nothing else.`, { id: session.id, resume: true });
      const again = parsePlanBlock(fix.all, reserved);
      if ("plan" in again) parsed = again;
      out = fix.ok ? out : fix;
    }
    if ("plan" in parsed) return savePlanRecord(repo, { plan: parsed.plan as StackPlan, approved: false, source: "claude", sha: await headSha(worktree) });
    return savePlanRecord(repo, { planError: (out.ok ? parsed.error : out.error ?? parsed.error).slice(0, 300) });
  })();
  planning.set(repo, run);
  run.finally(() => planning.delete(repo)).catch(() => undefined);
  return run;
}
