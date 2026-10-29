import "server-only";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { parseReply, parseStreamLine, BriefGenSchema, validateBrief, type Ask } from "./intake-parse";
import { startShaping } from "./jobs";
import { generate } from "./llm";
import { pieceView, piecesFromBrief } from "./pieces";
import { toolEnv } from "./sources/cli";
import { DATA_DIR, getFeature, getSettings, id, now, updateFeature } from "./store";
import type { Brief, ChatMessage, Feature, FeatureView, IntakeState } from "./types";
import { lambdaPrompt } from "./lambdamd";

// Intake: a Claude Code session (plan mode, read-only) on a lambda-owned detached worktree of the configured
// repo's main branch. One `claude -p` per turn: first turn --session-id, later --resume. The session asks
// what's unclear (lambda-ask blocks → chips) and, once the feature is clear, writes a lambda-brief block →
// feature.briefDoc + pieces → shaping jobs.
//
// The user's checkout is never touched: in repoPath we only run read-only git commands and `worktree add`.

const TURN_TIMEOUT_MS = 4 * 60 * 1000;
// ask_codebase runs inside a chat message: a tighter budget than an intake turn
const CODE_TIMEOUT_MS = 90 * 1000;
const CODE_MAX_TURNS = 12;
const CODE_BUDGET_USD = 0.75;
const MAX_THREAD = 200;
export const WORKTREES_DIR = path.join(DATA_DIR, "worktrees");
const BLANK_DIR = path.join(DATA_DIR, "intake-blank"); // cwd when no repo is configured

export const INTAKE_PROMPT = `
you are lambda's intake partner. a developer just named a feature. your job: make it clear enough to build, then write the brief. you never build it.

how to work:
- read the relevant code first (Read, Grep, Glob). ground every question in what exists: name real routes, components, tables, services.
- ask ONLY what is unclear or risky. if the code or the request already answers it, don't ask — state the assumption in one line.
- at most 3 questions per turn. each question short (<= 15 words).
- prefer multiple choice. for each question emit one fenced block, nothing else inside:
\`\`\`lambda-ask
{"question": "who can send invites?", "options": ["owners only", "owners + admins", "any member"], "multi": false}
\`\`\`
  2-5 options, each <= 6 words. "multi": true only when several can apply. free text is always allowed, don't add an "other" option.
- outside the blocks: ONE sentence (<= 25 words) on what the code does today, then the questions. no headings, no bullet walls, no file-by-file tour, no restating the request, no praise.
- never write code, never propose file edits, never call ExitPlanMode. you are in a read-only checkout.

when the feature is clear (usually after 1-3 rounds), or the developer says "go" / "ship it" / "that's enough", emit exactly one block and one short confirmation line:
\`\`\`lambda-brief
{"summary": "<= 40 words",
 "roles": ["user types involved"],
 "inScope": ["each <= 10 words"], "outOfScope": ["each <= 10 words"],
 "decisions": [{"q": "short question", "a": "short answer"}],
 "openQuestions": ["left for edge cases"],
 "surfaces": ["real routes / components / tables / services this touches"],
 "pieces": [{"title": "<= 6 words", "why": "<= 15 words", "scope": ["what this PR covers"]}]}
\`\`\`
pieces = separate PRs, in build order. default to ONE piece. split only when it genuinely should ship separately: several surfaces or roles that stand alone, or a risky migration that must land first. max 5. each piece vertically shippable and verifiable in a browser on its own.
the JSON must be valid. no lambda-ask blocks in the same reply as the brief.
`.trim();

// ---------- live turns (one per feature; survive HMR) ----------

// cwd: the checkout this session reads (set under the worktree lock, so a refresh never moves it mid-read)
type Live = { ac: AbortController; child?: ChildProcess; trace: string; text: string; startedAt: number; cwd?: string };
const G = globalThis as { __lambdaIntake?: Map<string, Live>; __lambdaIntakeReaper?: boolean; __lambdaWorktreeLock?: Promise<unknown> };
const live = (G.__lambdaIntake ??= new Map());
if (!G.__lambdaIntakeReaper) {
  G.__lambdaIntakeReaper = true;
  process.on("exit", () => {
    for (const l of live.values()) l.child?.kill("SIGTERM");
  });
}

export const isIntakeLive = (fid: string) => live.has(fid);
export function intakeLive(fid: string): { live: boolean; trace?: string; text?: string } {
  const l = live.get(fid);
  return l ? { live: true, trace: l.trace, text: l.text } : { live: false };
}

export function stopIntake(fid: string): boolean {
  const l = live.get(fid);
  if (!l) return false;
  l.ac.abort();
  return true;
}

// the intake turn and any ask_codebase question (feature deleted, say)
export function stopAllIntake(fid: string): boolean {
  const a = stopIntake(fid);
  const b = stopIntake(`${fid}:code`);
  return a || b;
}

const waitIdle = async (key: string, ms: number) => {
  for (const end = Date.now() + ms; live.has(key) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
  return !live.has(key);
};

export class IntakeBusyError extends Error {
  constructor() {
    super("lambda is still thinking");
  }
}

// ---------- worktree ----------

const execP = promisify(execFile);
// hooks off: `worktree add` / `checkout` would otherwise run the repo's post-checkout hooks
const GIT_CFG = ["-c", "core.hooksPath=/dev/null", "-c", "advice.detachedHead=false"];
export async function git(args: string[], cwd?: string): Promise<string> {
  const env = toolEnv();
  const { stdout } = await execP("git", [...GIT_CFG, ...(cwd ? ["-C", cwd] : []), ...args], { env, timeout: 60_000, maxBuffer: 4 << 20 });
  return stdout.trim();
}
export const gitOk = (args: string[], cwd?: string) => git(args, cwd).then((s) => s || "ok", () => "");

// main, else master, else origin's default branch. Read-only in the user's repo.
export async function defaultBranch(repo: string): Promise<{ ref: string; name: string } | null> {
  for (const b of ["main", "master"]) if (await gitOk(["rev-parse", "--verify", "--quiet", `refs/heads/${b}^{commit}`], repo)) return { ref: `refs/heads/${b}`, name: b };
  const origin = await gitOk(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repo); // e.g. origin/trunk
  if (origin && origin !== "ok") {
    const name = origin.replace(/^origin\//, "");
    if (await gitOk(["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`], repo)) return { ref: `refs/heads/${name}`, name };
    return { ref: `refs/remotes/${origin}`, name: origin };
  }
  return null;
}

export const worktreeDirFor = (repo: string) => path.join(WORKTREES_DIR, crypto.createHash("sha1").update(repo).digest("hex").slice(0, 10));

export type Worktree = { dir: string; sha: string; branch: string } | { dir: null; reason: string };

// serialised: two features starting at once must not race on `worktree add`
function worktreeLock<T>(work: () => Promise<T>): Promise<T> {
  const run = (G.__lambdaWorktreeLock ?? Promise.resolve()).then(work);
  G.__lambdaWorktreeLock = run.catch(() => undefined);
  return run;
}

// Lambda's detached checkout of the repo's default branch. refresh = move it to the branch's current tip
// (local ref only; never fetches) — skipped while another live session is reading that checkout. The
// user's working tree, index and branch are never touched. `self` is claimed on the dir under the lock.
export function prepareWorktree(repoPath: string, refresh: boolean, self?: Live): Promise<Worktree> {
  return worktreeLock(async () => {
    if (!repoPath) return { dir: null, reason: "no repo configured" };
    let repo: string;
    try {
      repo = fs.realpathSync(repoPath);
    } catch {
      return { dir: null, reason: "repo path not found" };
    }
    const top = await gitOk(["rev-parse", "--show-toplevel"], repo);
    if (!top || top === "ok") return { dir: null, reason: "repo path is not a git repo" };
    const branch = await defaultBranch(top);
    if (!branch) return { dir: null, reason: "no main branch found" };
    const sha = await git(["rev-parse", `${branch.ref}^{commit}`], top);
    const dir = worktreeDirFor(top);
    // a real worktree of its own (rev-parse would otherwise walk up into some enclosing repo)
    const valid = fs.existsSync(path.join(dir, ".git")) && (await gitOk(["rev-parse", "--show-toplevel"], dir)) === fs.realpathSync(dir);
    if (!valid) {
      if (path.dirname(dir) === WORKTREES_DIR) fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(WORKTREES_DIR, { recursive: true });
      try {
        await git(["worktree", "add", "--detach", dir, sha], top);
      } catch (e) {
        // a stale registration (dir deleted by hand) blocks a plain add
        if (!/already registered|missing but/i.test(String((e as { stderr?: string }).stderr ?? e))) throw e;
        await git(["worktree", "add", "-f", "--detach", dir, sha], top);
      }
    } else {
      const head = await gitOk(["rev-parse", "HEAD"], dir);
      const inUse = [...live.values()].some((l) => l !== self && l.cwd === dir);
      if (refresh && head !== sha && !inUse) await git(["checkout", "--detach", "--force", sha], dir);
      else if (head && head !== "ok" && head !== sha) {
        if (self) self.cwd = dir;
        return { dir, sha: head, branch: branch.name }; // what the checkout really holds
      }
    }
    if (self) self.cwd = dir;
    return { dir, sha, branch: branch.name };
  });
}

// ---------- one claude turn ----------

export type IntakeEvent =
  | { type: "text"; delta: string; reset?: boolean } // reset: a new message started, drop the live text
  | { type: "status"; line: string }
  | { type: "ask"; ask: Ask }
  | { type: "brief"; brief: Brief }
  | { type: "feature"; feature: FeatureView }
  | { type: "done" }
  | { type: "error"; message: string };

// text: the final message (display). all: every top-level assistant message of the run, so blocks written
// before a last tool call aren't lost (parse blocks from this).
type ClaudeOut = { ok: boolean; text: string; all: string; error?: string; noSession?: boolean };

type RunLimits = { maxTurns: number; timeoutMs: number; budgetUsd?: number };
const INTAKE_LIMITS: RunLimits = { maxTurns: 40, timeoutMs: TURN_TIMEOUT_MS };

// Sandboxed like verify.ts: the repo is untrusted input, so the session gets read-only file tools only —
// no MCP servers (user's or the repo's .mcp.json), no project/local settings or hooks from the checkout.
export function claudeArgs(prompt: string, session: { id: string; resume: boolean }, limits: RunLimits = INTAKE_LIMITS): string[] {
  return [
    "-p",
    prompt.startsWith("-") ? ` ${prompt}` : prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", "plan",
    "--append-system-prompt", `${INTAKE_PROMPT}\n\n${lambdaPrompt()}`, // + the developer's lambda.md
    "--max-turns", String(limits.maxTurns),
    ...(limits.budgetUsd ? ["--max-budget-usd", String(limits.budgetUsd)] : []),
    ...(session.resume ? ["--resume", session.id] : ["--session-id", session.id]),
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify({ mcpServers: {} }),
    "--setting-sources", "user",
    "--tools", "Read", "Grep", "Glob",
  ];
}

function runClaude(opts: {
  cwd: string;
  prompt: string;
  session: { id: string; resume: boolean };
  l: Live;
  emit: (e: IntakeEvent) => void;
  limits?: RunLimits;
}): Promise<ClaudeOut> {
  const { cwd, l, emit } = opts;
  const limits = opts.limits ?? INTAKE_LIMITS;
  return new Promise((resolve) => {
    // a stop that landed before the spawn (worktree prep, between runs) must not start a child
    if (l.ac.signal.aborted) return resolve({ ok: false, text: "", all: "", error: "stopped" });
    const env = toolEnv();
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    let child: ChildProcess;
    try {
      child = spawn("claude", claudeArgs(opts.prompt, opts.session, limits), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, text: "", all: "", error: `could not start claude: ${e instanceof Error ? e.message : e}` });
    }
    l.child = child;
    let buf = "";
    let stderr = "";
    let lastAssistant = "";
    const assistant: string[] = [];
    const all = () => assistant.join("\n\n");
    let result: Omit<ClaudeOut, "all"> | null = null;
    let streamed = false; // current message has streamed text
    const kill = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 4000).unref();
    };
    const timer = setTimeout(() => {
      result = { ok: false, text: lastAssistant, error: "took too long — try a narrower answer" };
      kill();
    }, limits.timeoutMs);
    const onAbort = () => kill();
    l.ac.signal.addEventListener("abort", onAbort, { once: true });
    if (l.ac.signal.aborted) kill();

    const onLine = (line: string) => {
        if (!line.trim()) return;
        for (const ev of parseStreamLine(line, cwd)) {
          if (ev.kind === "message") {
            if (streamed) emit({ type: "text", delta: "", reset: true });
            streamed = false;
            l.text = "";
          } else if (ev.kind === "text") {
            streamed = true;
            l.text += ev.delta;
            emit({ type: "text", delta: ev.delta });
          } else if (ev.kind === "tool") {
            l.trace = ev.line;
            emit({ type: "status", line: ev.line });
          } else if (ev.kind === "assistant") {
            lastAssistant = ev.text;
            if (assistant[assistant.length - 1] !== ev.text) assistant.push(ev.text);
          } else if (ev.kind === "result" && !result)
            result = { ok: ev.ok, text: ev.text || lastAssistant, ...(ev.error ? { error: ev.error } : {}) };
        }
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => (stderr = (stderr + c).slice(-4000)));

    let settled = false;
    const done = (code: number | null, err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      l.ac.signal.removeEventListener("abort", onAbort);
      l.child = undefined;
      // the last line may lack its newline
      if (buf.trim()) onLine(buf);
      buf = "";
      // stopped: nothing from this run counts (no brief / asks applied after the user hit stop)
      if (l.ac.signal.aborted) return resolve({ ok: false, text: "", all: "", error: "stopped" });
      if (err) return resolve({ ok: false, text: "", all: "", error: `could not start claude: ${err.message}` });
      if (result) return resolve({ ...result, all: all() || result.text });
      const noSession = /no conversation found/i.test(stderr);
      const last = stderr.trim().split("\n").pop()?.slice(0, 160);
      resolve({ ok: false, text: lastAssistant, all: all(), noSession, error: last || `claude exited (${code ?? "killed"})` });
    };
    child.on("error", (e) => done(null, e));
    child.on("close", (code) => done(code));
  });
}

// ---------- the turn ----------

const intakeTurns = (f: Feature) => (f.chat ?? []).filter((m) => m.source === "intake");

function transcript(f: Feature): string {
  return intakeTurns(f)
    .map((m) => (m.role === "user" ? `developer: ${m.text}` : m.ask ? `you asked: ${m.ask.question}` : m.text ? `you: ${m.text}` : ""))
    .filter(Boolean)
    .join("\n");
}

function opener(f: Feature, wt: Worktree, prior?: string): string {
  const lines = [`new feature: ${f.title}`];
  if (f.brief.trim()) lines.push(`developer's notes:\n${f.brief.trim()}`);
  lines.push(
    wt.dir
      ? `you're in a read-only checkout of ${wt.branch} @ ${wt.sha.slice(0, 7)}. read the relevant code before asking anything.`
      : `no codebase is available (${"reason" in wt ? wt.reason : "no repo"}). ask from product sense only, and say once — briefly — that you can't see the code.`,
  );
  if (prior) lines.push(`conversation so far (the previous session was lost — continue from here):\n${prior}`);
  return lines.join("\n\n");
}

const patchIntake = (f: Feature, patch: Partial<IntakeState>) => {
  f.intake = { status: "idle", ...f.intake, ...patch };
  if (!patch.error && patch.status !== "error") delete f.intake.error;
};

function pushTurns(f: Feature, turns: Omit<ChatMessage, "id" | "at">[]) {
  f.chat = [...(f.chat ?? []), ...turns.map((t) => ({ ...t, id: id("ct"), at: now() }))].slice(-MAX_THREAD);
}

// One developer message → one (or, for a brief that needs fixing, two) claude runs. Persists the user turn
// first and lambda's reply last. Keeps running if the client disconnects; stopIntake() kills it.
export async function runIntakeTurn(fid: string, text: string, emit: (e: IntakeEvent) => void): Promise<void> {
  if (live.has(fid)) throw new IntakeBusyError();
  const l: Live = { ac: new AbortController(), trace: "", text: "", startedAt: Date.now() };
  live.set(fid, l);
  try {
    const f0 = getFeature(fid);
    if (!f0) throw new Error("feature not found");
    if (f0.phase !== "intake") throw new Error("intake is done — use ask lambda");
    const prior = transcript(f0);
    await updateFeature(fid, (f) => {
      pushTurns(f, [{ role: "user", text, source: "intake" }]);
      patchIntake(f, { status: "thinking" });
    });

    const fresh = !f0.intake?.sessionId;
    emit({ type: "status", line: fresh ? "opening the codebase" : "thinking" });
    const wt = await prepareWorktree(getSettings().repoPath, fresh, l).catch((e): Worktree => ({ dir: null, reason: `worktree failed: ${String(e?.message ?? e).slice(0, 80)}` }));
    const cwd = wt.dir ?? BLANK_DIR;
    fs.mkdirSync(cwd, { recursive: true });
    // sessions live per cwd: a moved repo means a new session (replaying the transcript)
    let resume = !fresh && f0.intake?.worktree === cwd;
    let sessionId = resume ? f0.intake!.sessionId! : crypto.randomUUID();
    const promptFor = (replay: boolean) => (resume ? text : `${opener(f0, wt, replay ? prior : undefined)}\n\ndeveloper: ${text}`);
    let out = await runClaude({ cwd, prompt: promptFor(!fresh), session: { id: sessionId, resume }, l, emit });
    if (!out.ok && out.noSession && resume && !l.ac.signal.aborted) {
      resume = false;
      sessionId = crypto.randomUUID();
      emit({ type: "text", delta: "", reset: true });
      out = await runClaude({ cwd, prompt: promptFor(true), session: { id: sessionId, resume }, l, emit });
    }
    await updateFeature(fid, (f) =>
      patchIntake(f, { sessionId, worktree: cwd, ...(wt.dir ? { mainSha: wt.sha } : {}) }),
    );

    const stopped = l.ac.signal.aborted || out.error === "stopped";
    // blocks from every message of the run; the prose shown is the final message's
    const blocks = stopped ? parseReply("") : parseReply(out.all);
    let parsed = { ...blocks, text: stopped ? "" : parseReply(out.text).text };
    // invalid brief → ask the session to re-emit once
    if (out.ok && !stopped && parsed.briefError && !parsed.brief) {
      emit({ type: "status", line: "tidying the brief" });
      const fix = await runClaude({
        cwd,
        prompt: `your lambda-brief block didn't validate (${parsed.briefError}). re-emit exactly one valid lambda-brief block, nothing else.`,
        session: { id: sessionId, resume: true },
        l,
        emit,
      });
      const again = l.ac.signal.aborted ? parseReply("") : parseReply(fix.all);
      if (again.brief) parsed = { ...parsed, brief: again.brief, briefError: undefined };
    }
    const brief = l.ac.signal.aborted ? undefined : parsed.brief;
    const reply = parsed.text || (brief ? "clear — shaping it now." : "");
    const error = stopped ? "stopped" : out.ok ? (parsed.briefError && !brief ? "brief didn't validate — say “go” to retry" : undefined) : out.error;
    const asks = brief || stopped ? [] : parsed.asks;

    for (const ask of asks) emit({ type: "ask", ask });
    const turns: Omit<ChatMessage, "id" | "at">[] = [];
    if (reply || error || !asks.length) turns.push({ role: "assistant", text: reply, source: "intake", ...(error ? { error } : {}) });
    for (const ask of asks) turns.push({ role: "assistant", text: ask.question, ask, source: "intake" });
    let moved = false; // skipped / settled elsewhere while this turn ran: don't write intake state over it
    let feature = await updateFeature(fid, (f) => {
      if (f.phase !== "intake") {
        moved = true;
        return;
      }
      pushTurns(f, turns);
      patchIntake(f, error && !stopped ? { status: "error", error } : { status: brief ? "ready" : "asking" });
    });

    if (brief && !moved) {
      emit({ type: "brief", brief });
      feature = await applyBrief(fid, brief);
    }
    emit({ type: "feature", feature: pieceView(feature) });
    if (error && !stopped) emit({ type: "error", message: error });
    else emit({ type: "done" });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await updateFeature(fid, (f) => {
      if (f.phase === "intake") patchIntake(f, { status: "error", error: message.slice(0, 160) });
    }).catch(() => undefined);
    throw e;
  } finally {
    live.delete(fid);
  }
}

// ---------- ask_codebase (post-intake chat tool) ----------

const CODE_WORDS = 60;

// Resumes the feature's intake Claude Code session (same worktree, plan mode) with one question and returns
// its plain answer (<= ~60 words). No session yet (skipped intake / old feature) → starts one and keeps it.
export async function askCodebase(fid: string, question: string, signal?: AbortSignal): Promise<string> {
  const key = `${fid}:code`;
  if (live.has(key) || live.has(fid)) throw new IntakeBusyError();
  const l: Live = { ac: new AbortController(), trace: "", text: "", startedAt: Date.now() };
  live.set(key, l);
  const onAbort = () => l.ac.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) l.ac.abort();
  try {
    const f = getFeature(fid);
    if (!f) throw new Error("feature not found");
    const wt = await prepareWorktree(getSettings().repoPath, false, l);
    if (!wt.dir) throw new Error(`no codebase to ask (${"reason" in wt ? wt.reason : "no repo"})`);
    const resume = !!f.intake?.sessionId && f.intake.worktree === wt.dir;
    const sessionId = resume ? f.intake!.sessionId! : crypto.randomUUID();
    const ask = [
      "question about the code (intake is over — do NOT emit lambda-ask or lambda-brief blocks):",
      question,
      `answer from the code you read, in <= ${CODE_WORDS} words of plain text. name real files / routes / tables. say so if the code doesn't tell.`,
    ].join("\n\n");
    const prompt = resume ? ask : `${opener(f, wt)}\n\n${ask}`;
    const out = await runClaude({
      cwd: wt.dir,
      prompt,
      session: { id: sessionId, resume },
      l,
      emit: () => {},
      limits: { maxTurns: CODE_MAX_TURNS, timeoutMs: CODE_TIMEOUT_MS, budgetUsd: CODE_BUDGET_USD },
    });
    if (!resume && out.ok)
      await updateFeature(fid, (x) => patchIntake(x, { sessionId, worktree: wt.dir, mainSha: wt.sha, status: x.intake?.status ?? "ready" }));
    if (!out.ok) throw new Error(out.error ?? "codebase session failed");
    const text = parseReply(out.text).text;
    const words = text.split(/\s+/);
    return words.length > CODE_WORDS ? `${words.slice(0, CODE_WORDS).join(" ")}…` : text;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    live.delete(key);
  }
}

// ---------- brief → pieces → shaping ----------

// Settles the intake: structured brief + one piece per brief piece, then context + every piece's pipeline.
// Pieces that already hold work (e.g. generated before intake finished) are kept, never replaced.
export async function applyBrief(fid: string, brief: Brief): Promise<Feature> {
  await updateFeature(fid, (f) => {
    if (f.phase !== "intake") throw new Error("intake is already done");
    f.briefDoc = brief;
    f.brief = brief.summary;
    const hasWork = f.pieces.some((p) => p.stories.length || p.flowcharts.length || p.mockups.length || p.runs.length);
    if (!hasWork) f.pieces = piecesFromBrief(brief);
    patchIntake(f, { status: "ready" });
  });
  return startShaping(fid);
}

// "skip — just shape it": one structured call from the title / notes / whatever was said so far.
export async function skipIntake(fid: string): Promise<Feature> {
  // the live turn must be gone (child killed, its last write done) before the brief is written
  if (stopIntake(fid) && !(await waitIdle(fid, 12_000))) throw new IntakeBusyError();
  const f = getFeature(fid);
  if (!f) throw new Error("feature not found");
  if (f.phase !== "intake") throw new Error("intake is already done");
  const said = transcript(f);
  const out = await generate({
    schema: BriefGenSchema,
    effort: "low",
    maxTokens: 3000,
    system: "write the build brief for this feature. default to ONE piece; split into separate PRs only when it clearly should ship separately (max 5). don't invent requirements: unknowns go to openQuestions.",
    prompt: `feature: ${f.title}${f.brief.trim() ? `\n\nnotes:\n${f.brief.trim()}` : ""}${said ? `\n\nconversation so far:\n${said}` : ""}`,
  });
  const v = validateBrief(out);
  if ("error" in v) throw new Error(`brief didn't validate: ${v.error}`);
  await updateFeature(fid, (x) => pushTurns(x, [{ role: "assistant", text: "skipped the questions — shaping from what we have.", source: "intake" }]));
  return applyBrief(fid, v.brief);
}
