import "server-only";
import path from "node:path";
import { clearAuth } from "../auth";
import { secret } from "../env";
import { getSettings, id, saveSettings } from "../store";
import type { Settings, TestAccount } from "../types";
import { isDir, safePath, setupCtx, type SetupCtx } from "./ctx";
import { hasKeyOutsideRepo, validKey, writeOwnKey } from "./keys";
import { plan, type Plan } from "./plan";
import { detectRepo, resolveLogin, type RepoReport } from "./repo";
import { dominant, rankRepos, type RepoCandidate } from "./repos";
import { chromiumStatus, claudeAuth, detectTools, type ClaudeAuth, type ToolsReport } from "./tools";

// The setup flow, end to end: detect → plan → (the user answers the leftovers) → apply.

export type DetectReport = { tools: ToolsReport | null; repos: RepoCandidate[]; chosen: string | null; repo: RepoReport | null; plan: Plan };

type Deps = { tools?: () => Promise<ToolsReport | null>; auth?: () => Promise<ClaudeAuth> };

export async function detect(o: Partial<SetupCtx> = {}, deps: Deps = {}): Promise<DetectReport> {
  const ctx = setupCtx(o);
  const [tools, repos] = await Promise.all([(deps.tools ?? detectTools)(), rankRepos(ctx)]);
  const top = dominant(repos);
  const root = top ? safePath(top.path, ctx.home, "dir") : null; // detection and apply share one rule
  const repo = root ? await detectRepo(root, ctx) : null;
  return { tools, repos, chosen: repo ? root : null, repo, plan: planFor(ctx, repos, repo ? root : null, repo, tools) };
}

// The user picked a repo (or typed a path): detect it and re-plan with that choice settled.
export async function detectChosen(repoPath: unknown, o: Partial<SetupCtx> = {}, deps: Deps = {}) {
  const ctx = setupCtx(o);
  const root = safePath(repoPath, ctx.home, "dir");
  if (!root) return null;
  const [repo, tools] = await Promise.all([detectRepo(root, ctx), deps.tools ? deps.tools() : Promise.resolve(null)]);
  return { repo, plan: planFor(ctx, [], root, repo, tools) };
}

function planFor(ctx: SetupCtx, repos: RepoCandidate[], chosen: string | null, repo: RepoReport | null, tools: ToolsReport | null) {
  return plan({
    repos,
    chosen,
    repo,
    tools,
    anthropicElsewhere: hasKeyOutsideRepo("ANTHROPIC_API_KEY", ctx.dataDir),
    existingAccounts: getSettings().accounts.length,
  });
}

// ---------- apply ----------

export type ApplyBody = {
  repoPath?: unknown;
  envPath?: unknown;
  frontendUrl?: unknown;
  migrations?: unknown; // { dir, extra[] }
  appHosts?: unknown;
  accountCandidateId?: unknown;
  account?: unknown; // { label, loginUrl, email, password }
  anthropicKey?: unknown;
};

export class SetupError extends Error {}

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);

function httpUrl(v: unknown): string | null {
  const s = str(v, 1000);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href.replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

// a migrations dir relative to the repo, that exists, and doesn't climb out
function relDir(root: string, v: unknown): string | null {
  const s = str(v, 300);
  if (s === undefined || s === "" || path.isAbsolute(s)) return null;
  const abs = path.resolve(root, s);
  if (!abs.startsWith(root + path.sep) || !isDir(abs)) return null;
  return path.relative(root, abs);
}

export async function apply(body: ApplyBody, o: Partial<SetupCtx> = {}): Promise<Settings> {
  const ctx = setupCtx({ ...o, probe: false });
  const root = safePath(body.repoPath, ctx.home, "dir");
  if (!root) throw new SetupError("repoPath must be an existing folder inside your home folder");
  const key = body.anthropicKey === undefined || body.anthropicKey === "" ? null : str(body.anthropicKey, 400);
  if (key !== null && !validKey("ANTHROPIC_API_KEY", key)) throw new SetupError("that doesn't look like an Anthropic key (sk-ant-…)");
  const r = await detectRepo(root, ctx);
  const cur = getSettings();
  const patch: Partial<Settings> = { repoPath: root };

  // env file: explicit (validated), explicit "" (none), else the detected best
  if (body.envPath === "") patch.envPath = "";
  else if (body.envPath !== undefined) {
    const p = safePath(body.envPath, ctx.home, "file");
    if (!p) throw new SetupError("envPath must be an existing file inside your home folder");
    patch.envPath = p;
  } else patch.envPath = r.envPath ?? "";

  if (body.frontendUrl !== undefined) {
    const u = httpUrl(body.frontendUrl);
    if (!u) throw new SetupError("frontendUrl must be an http(s) url");
    patch.frontendUrl = u;
  } else if (r.frontend) patch.frontendUrl = r.frontend.url;

  if (body.migrations && typeof body.migrations === "object") {
    const m = body.migrations as { dir?: unknown; extra?: unknown };
    const dir = m.dir === "" ? "" : relDir(root, m.dir);
    if (dir === null) throw new SetupError("migrations.dir must be a folder inside the repo");
    const extra = Array.isArray(m.extra) ? m.extra.slice(0, 20).map((x) => relDir(root, x)) : [];
    if (extra.some((x) => x === null)) throw new SetupError("migrations.extra must be folders inside the repo");
    patch.migrationsDir = dir;
    patch.extraMigrationDirs = extra as string[];
  } else {
    patch.migrationsDir = r.migrations?.dir ?? "";
    patch.extraMigrationDirs = r.migrations?.extra ?? [];
  }

  if (Array.isArray(body.appHosts))
    patch.appHosts = body.appHosts.map((h) => str(h, 63)?.toLowerCase()).filter((h): h is string => !!h && /^[a-z0-9-]{2,63}$/.test(h)).slice(0, 20);
  else patch.appHosts = r.appHosts;


  // test login: a detected candidate (password copied server-side) or typed in
  let acct: Omit<TestAccount, "id"> | null = null;
  if (typeof body.accountCandidateId === "string" && /^[0-9a-f]{16}$/.test(body.accountCandidateId)) {
    const l = await resolveLogin(root, body.accountCandidateId);
    if (!l) throw new SetupError("that test login is no longer in the repo's env files");
    const a = (body.account ?? {}) as Record<string, unknown>;
    acct = { label: str(a.label, 80) || l.label, loginUrl: str(a.loginUrl, 1000) || l.loginUrl, email: l.email, password: l.password };
  } else if (body.account && typeof body.account === "object") {
    const a = body.account as Record<string, unknown>;
    const email = str(a.email, 200);
    if (email) acct = { label: str(a.label, 80) || "test account", loginUrl: str(a.loginUrl, 1000) || "/login", email, password: typeof a.password === "string" ? a.password.slice(0, 500) : "" };
  }
  if (acct) {
    const prev = cur.accounts.find((x) => x.email.toLowerCase() === acct.email.toLowerCase());
    const next: TestAccount = { id: prev?.id ?? id("acct"), ...acct, password: acct.password || prev?.password || "" };
    if (prev) clearAuth(prev.id);
    patch.accounts = prev ? cur.accounts.map((x) => (x.id === prev.id ? next : x)) : [...cur.accounts, next];
  }
  // writes only after every field validated
  if (key) writeOwnKey(ctx.dataDir, "ANTHROPIC_API_KEY", key);
  if (patch.frontendUrl && patch.frontendUrl !== cur.frontendUrl) for (const a of patch.accounts ?? cur.accounts) clearAuth(a.id);

  return saveSettings(patch);
}

// ---------- status ----------

export type SetupStatus = { configured: boolean; missing: ("repo" | "anthropicKey" | "claudeLogin")[]; recommended: "chromium"[] };

// a known answer is cached 30s; an unknown one (timeout, odd output) is retried next time
let authCache: { at: number; v: Promise<ClaudeAuth> } | null = null;
const cachedAuth = () => {
  if (!authCache || Date.now() - authCache.at > 30_000) {
    const v = claudeAuth();
    authCache = { at: Date.now(), v };
    const drop = () => {
      if (authCache?.v === v) authCache = null;
    };
    v.then((a) => {
      if (!a) drop();
    }, drop);
  }
  return authCache.v;
};

export async function status(deps: Deps & { chromium?: () => Promise<{ installed: boolean }> } = {}): Promise<SetupStatus> {
  const s = getSettings();
  const missing: SetupStatus["missing"] = [];
  if (!s.repoPath || !isDir(s.repoPath)) missing.push("repo");
  if (!secret("ANTHROPIC_API_KEY")) missing.push("anthropicKey");
  const auth = await (deps.auth ?? cachedAuth)();
  if (auth?.loggedIn === false) missing.push("claudeLogin"); // null = unknown: same as the planner, don't nag
  const chromium = await (deps.chromium ?? chromiumStatus)();
  return { configured: missing.length === 0, missing, recommended: chromium.installed ? [] : ["chromium"] };
}
