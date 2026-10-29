// Wire layer for /api/setup/* (engine: src/lib/setup). The screens work on `Model` + `Values`;
// `rowsFor` turns them into the checklist. Secrets never come back from the server: keys are booleans.

import type { SettingsView } from "@/components/settings/types";

// ---------- engine shapes (mirrors src/lib/setup, client-safe) ----------

export type Tool = { name: string; installed: boolean; version?: string };
export type Tools = {
  tools: Tool[];
  claude: Tool & { auth: { loggedIn: boolean; authMethod?: string; email?: string } | null };
  chromium: { installed: boolean; revision?: string };
};
export type RepoOption = { path: string; name: string; sessions: number; lastUsed: string | null; branch?: string | null; web?: boolean };
export type LoginCandidate = {
  id: string;
  label: string;
  loginUrlGuess: string;
  loginUrlSource: string | null; // null = "/login" by convention, not found in the repo
  email: string;
  hasPassword: boolean;
  bot: boolean; // a CI / automation account
  from: string;
};
export type RepoReport = {
  path: string;
  name: string;
  branch: string | null;
  envFiles: { path: string; rel: string; keys: string[] }[];
  envPath: string | null;
  frontend: { url: string; source: string; up: boolean | null } | null;
  migrations: { dir: string; extra: string[]; counts: Record<string, number> } | null;
  appHosts: string[];
  logins: LoginCandidate[];
  partial?: boolean;
};
export type Question =
  | { id: "repo"; kind: "choice"; prompt: string; options: RepoOption[]; default: string | null; optional?: false }
  | { id: "anthropicKey"; kind: "secret"; prompt: string; hint: string; optional?: false }
  | {
      id: "testLogin";
      kind: "account";
      optional: true;
      prompt: string;
      candidates: LoginCandidate[];
      prefill: { candidateId: string | null; label: string; loginUrl: string; email: string };
    }
  | { id: "frontendUrl"; kind: "url"; prompt: string; default: string; optional?: false };
export type EnginePlan = {
  patch: Partial<Values>;
  questions: Question[];
  actions: { id: "installClaude" | "claudeLogin" | "installChromium"; blocking: boolean; label: string; hint: string }[];
};
export type Status = { configured: boolean; missing: string[]; recommended?: string[] };

// ---------- the UI model ----------

export type Values = {
  repoPath: string;
  envPath: string;
  frontendUrl: string;
  migrationsDir: string;
  extraMigrationDirs: string[];
  appHosts: string[];
};

export type Model = {
  tools: Tools | null;
  repos: RepoOption[];
  repo: RepoReport | null;
  plan: EnginePlan;
  current: SettingsView;
  lambdaMd: { isDefault: boolean; repo: boolean };
};

export type RowState = "ok" | "warn" | "missing";
export type EditKind = "path" | "url" | "list";
export type Row = {
  id: string;
  label: string;
  state: RowState;
  value?: string;
  detail?: string; // secondary text after the value, hidden on narrow screens
  dots?: { name: string; ok: boolean }[];
  up?: boolean;
  edit?: EditKind;
  raw?: string | string[];
  suggestions?: string[];
  action?: "install";
};

// ---------- fetch ----------

type J = Record<string, unknown>;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const json = (await res.json().catch(() => ({}))) as J;
  if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : `request failed (${res.status})`);
  return json as T;
}
const post = <T>(url: string, body: unknown = {}) => call<T>(url, { method: "POST", body: JSON.stringify(body) });

export const getStatus = () => call<Status>("/api/setup/status");
export const pickRepo = (path: string) => post<{ repo: RepoReport; plan: EnginePlan }>("/api/setup/repo", { path });

// Detect, then settle on a repo: the one already in settings wins (rerun = no questions), else the
// engine's dominant pick, else ask.
export async function scan(): Promise<Model> {
  const [d, current, md] = await Promise.all([
    post<{ tools: Tools | null; repos: RepoOption[]; chosen: string | null; repo: RepoReport | null; plan: EnginePlan }>("/api/setup/detect"),
    call<SettingsView>("/api/settings"),
    call<{ isDefault: boolean; repo: unknown }>("/api/lambda-md").catch(() => ({ isDefault: true, repo: null })),
  ]);
  let { repo, plan } = d;
  if (current.repoPath && current.repoPath !== d.chosen) {
    const r = await pickRepo(current.repoPath).catch(() => null);
    if (r) ({ repo, plan } = r);
  }
  // tools only come with the full detect; keep its machine actions
  plan = { ...plan, actions: d.plan.actions };
  return { tools: d.tools, repos: d.repos, repo, plan, current, lambdaMd: { isDefault: md.isDefault, repo: Boolean(md.repo) } };
}

export type ApplyBody = Partial<Omit<Values, "migrationsDir" | "extraMigrationDirs">> & {
  migrations?: { dir: string; extra: string[] };
  anthropicKey?: string;
  accountCandidateId?: string;
  account?: { label?: string; loginUrl: string; email?: string; password?: string }; // with a candidate id: only label / loginUrl are read
};
export const apply = (body: ApplyBody) => post<{ status: Status }>("/api/setup/apply", body);

// Streams `data: {json}` events (SSE framing) from the installer.
export async function installChromium(onLine: (line: string) => void): Promise<boolean> {
  const res = await fetch("/api/setup/install-chromium", { method: "POST" });
  if (!res.body) return false;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let ok = false;
  const take = (raw: string) => {
    const t = raw.replace(/^data:\s*/, "").trim();
    if (!t) return;
    try {
      const e = JSON.parse(t) as { type: string; text?: string; ok?: boolean; message?: string };
      if (e.type === "done") ok = Boolean(e.ok);
      else if (e.type === "error") onLine(e.message ?? "failed");
      else if (e.text) onLine(e.text);
    } catch {
      onLine(t);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    parts.forEach(take);
  }
  take(buf);
  return ok;
}

// ---------- values ----------

// Rerun on the repo already in settings: what you set wins. A new repo: what detection found.
export function valuesFor(m: Model): Values {
  const p = m.plan.patch;
  const repoPath = p.repoPath ?? m.repo?.path ?? m.current.repoPath;
  const keep = Boolean(m.current.repoPath) && m.current.repoPath === repoPath;
  const counts = m.repo?.migrations?.counts ?? {};
  const curMigOk = keep && (counts[m.current.migrationsDir] !== undefined || !m.repo?.migrations);
  return {
    repoPath,
    envPath: keep && m.current.envPath ? m.current.envPath : p.envPath ?? "",
    frontendUrl: keep && m.current.frontendUrl ? m.current.frontendUrl : p.frontendUrl ?? m.current.frontendUrl,
    migrationsDir: curMigOk ? m.current.migrationsDir : p.migrationsDir ?? "",
    extraMigrationDirs: curMigOk ? m.current.extraMigrationDirs : p.extraMigrationDirs ?? [],
    appHosts: keep && m.current.appHosts.length ? m.current.appHosts : p.appHosts ?? [],
  };
}

// questions the engine asked that the current settings already answer
export function questionsFor(m: Model, v: Values): Question[] {
  return m.plan.questions.filter((q) => {
    if (q.id === "repo") return !v.repoPath;
    if (q.id === "anthropicKey") return !hasAnthropic(m, v);
    if (q.id === "testLogin") return m.current.accounts.length === 0;
    if (q.id === "frontendUrl") return !(m.current.repoPath === v.repoPath && m.current.frontendUrl);
    return true;
  });
}

function keysIn(m: Model, envPath: string): Record<string, boolean> {
  if (envPath && envPath === m.current.envPath) return m.current.keys;
  const f = m.repo?.envFiles.find((x) => x.path === envPath);
  const has = (k: string) => Boolean(f?.keys.includes(k));
  return { ANTHROPIC_API_KEY: has("ANTHROPIC_API_KEY"), LINEAR_API_KEY: has("LINEAR_API_KEY"), SLACK_BOT_TOKEN: has("SLACK_BOT_TOKEN"), SLACK_TOKEN: has("SLACK_TOKEN") };
}
// in the env file, or anywhere else lambda reads (its own keys.env / process env — the engine then asks nothing)
const hasAnthropic = (m: Model, v: Values) =>
  keysIn(m, v.envPath).ANTHROPIC_API_KEY || !m.plan.questions.some((q) => q.id === "anthropicKey");

// ---------- rows ----------

const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function rowsFor(m: Model, v: Values, extra: { chromium?: boolean; key?: boolean } = {}): Row[] {
  const t = m.tools;
  const node = t?.tools.find((x) => x.name === "node");
  const repoOpt = m.repos.find((r) => r.path === v.repoPath);
  const keys = keysIn(m, v.envPath);
  const anthropic = hasAnthropic(m, v) || Boolean(extra.key);
  const counts = m.repo?.migrations?.counts ?? {};
  const migDirs = [v.migrationsDir, ...v.extraMigrationDirs].filter(Boolean);
  const migN = migDirs.reduce((a, d) => a + (counts[d] ?? 0), 0);
  const fe = m.repo?.frontend;
  const chromiumOk = Boolean(t?.chromium.installed || extra.chromium);
  const claude = t?.claude;

  return [
    {
      id: "claude",
      label: "claude code",
      state: !claude ? "warn" : !claude.installed || claude.auth?.loggedIn === false ? "missing" : claude.auth ? "ok" : "warn",
      value: !claude
        ? "unknown"
        : !claude.installed
          ? "not installed"
          : claude.auth?.loggedIn === false
            ? "run claude · log in"
            : claude.auth
              ? "logged in"
              : claude.version ?? "installed",
    },
    { id: "node", label: "node", state: node?.installed ? "ok" : "missing", value: node?.installed ? `v${node.version ?? "?"}` : "not found" },
    {
      id: "chromium",
      label: "test browser",
      state: chromiumOk ? "ok" : "warn",
      value: chromiumOk ? "chromium" : undefined,
      action: chromiumOk ? undefined : "install",
    },
    {
      id: "repo",
      label: "your app",
      state: v.repoPath ? "ok" : "missing",
      value: v.repoPath ? (m.repo?.name ?? tilde(v.repoPath)) : "not picked",
      detail: repoOpt?.sessions ? plural(repoOpt.sessions, "session") : undefined,
      edit: "path",
      raw: v.repoPath,
      suggestions: m.repos.map((r) => r.path),
    },
    {
      id: "keys",
      label: "keys",
      state: anthropic ? "ok" : "missing",
      dots: [
        { name: "anthropic", ok: anthropic },
        { name: "linear", ok: Boolean(keys.LINEAR_API_KEY) },
        { name: "slack", ok: Boolean(keys.SLACK_BOT_TOKEN || keys.SLACK_TOKEN) },
      ],
      edit: "path",
      raw: v.envPath,
      suggestions: m.repo?.envFiles.map((f) => f.path) ?? [],
    },
    {
      id: "appUrl",
      label: "app url",
      state: v.frontendUrl ? "ok" : "missing",
      value: v.frontendUrl.replace(/^https?:\/\//, "") || "not set",
      up: fe && fe.url === v.frontendUrl && fe.up !== null ? fe.up : undefined,
      edit: "url",
      raw: v.frontendUrl,
      suggestions: fe ? [fe.url] : [],
    },
    {
      id: "migrations",
      label: "migrations",
      state: migN && !m.repo?.partial ? "ok" : "warn",
      value: migN ? plural(migN, "file") : migDirs.length ? migDirs.join(", ") : m.repo?.partial ? "big repo · check" : "none found",
      edit: "list",
      raw: migDirs,
      suggestions: Object.keys(counts),
    },
    {
      id: "hosts",
      label: "api hosts",
      state: v.appHosts.length ? "ok" : "warn",
      value: v.appHosts.length ? v.appHosts.join(", ") : "none",
      edit: "list",
      raw: v.appHosts,
      suggestions: m.repo?.appHosts ?? [],
    },
    {
      id: "lambdamd",
      label: "lambda.md",
      state: "ok",
      value: `${m.lambdaMd.isDefault ? "default" : "yours"}${m.lambdaMd.repo ? " + repo" : ""}`,
    },
  ];
}
