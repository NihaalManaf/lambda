import "server-only";
import crypto from "node:crypto";
import path from "node:path";
import { parseEnv } from "../env";
import { readDir, readJsonFile, readText, SKIP_DIRS, timeBox, type SetupCtx } from "./ctx";

// Everything lambda can learn about one app repo without asking. Never returns secret values:
// env files report which known keys they hold (booleans); test logins carry the email only.

export const KNOWN_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LINEAR_API_KEY", "SLACK_BOT_TOKEN", "SLACK_TOKEN"];

export type EnvFile = { path: string; rel: string; keys: string[] };
export type FrontendGuess = { url: string; source: string; up: boolean | null };
export type Migrations = { dir: string; extra: string[]; counts: Record<string, number> };
export type LoginCandidate = {
  id: string;
  label: string;
  loginUrlGuess: string;
  loginUrlSource: string | null; // the route file it came from; null = "/login" by convention
  email: string;
  hasPassword: boolean;
  bot: boolean; // a CI / automation account
  from: string;
};

export type RepoReport = {
  path: string;
  name: string;
  branch: string | null;
  envFiles: EnvFile[];
  envPath: string | null; // best pick
  frontend: FrontendGuess | null;
  migrations: Migrations | null;
  appHosts: string[];
  logins: LoginCandidate[];
  partial: boolean; // the folder walk hit its budget: some folders weren't looked at
};

// ---------- small fs helpers ----------

export function gitBranch(root: string): string | null {
  const head = readText(path.join(root, ".git", "HEAD"), 512).trim();
  if (head) return head.match(/^ref: refs\/heads\/(.+)$/)?.[1] ?? head.slice(0, 7);
  // worktree: .git is a file pointing at the real gitdir
  const gitdir = readText(path.join(root, ".git"), 1024).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  if (!gitdir) return null;
  const h = readText(path.join(path.resolve(root, gitdir), "HEAD"), 512).trim();
  return h.match(/^ref: refs\/heads\/(.+)$/)?.[1] ?? (h ? h.slice(0, 7) : null);
}

// dirs under root down to `depth` (root itself = depth 0), skipping junk + dot dirs. Breadth-first, and
// the budget is charged per directory (not per file), so shallow folders like <root>/migrations are
// always seen before a deep subtree can use it up. `walk.partial` records a truncated walk.
export type Walk = { partial: boolean };
async function walkDirs(root: string, depth: number, walk: Walk = { partial: false }, budget = 4000): Promise<string[]> {
  const out = [root];
  let level = [root];
  for (let d = 0; d < depth && level.length; d++) {
    const next: string[] = [];
    for (const dir of level)
      for (const e of await readDir(dir)) {
        if (!e.isDirectory() || SKIP_DIRS.has(e.name) || (e.name.startsWith(".") && e.name !== ".github")) continue;
        if (out.length >= budget) {
          walk.partial = true;
          return out;
        }
        const p = path.join(dir, e.name);
        out.push(p);
        next.push(p);
      }
    level = next;
  }
  return out;
}

const ENV_NAME = /^\.env(\.[\w.-]+)?$/;
const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults?)$/i;

async function envFilesIn(root: string, walk?: Walk): Promise<{ path: string; rel: string; vars: Record<string, string> }[]> {
  const out: { path: string; rel: string; vars: Record<string, string> }[] = [];
  for (const dir of await walkDirs(root, 2, walk)) {
    for (const e of await readDir(dir)) {
      if (!e.isFile() || !ENV_NAME.test(e.name) || ENV_TEMPLATE.test(e.name)) continue;
      const p = path.join(dir, e.name);
      out.push({ path: p, rel: path.relative(root, p), vars: parseEnv(readText(p)) });
    }
  }
  return out;
}

const NAME_ORDER = [".env", ".env.local", ".env.development", ".env.development.local"];
const rank = (f: EnvFile) =>
  [
    f.keys.includes("ANTHROPIC_API_KEY") ? 0 : 1,
    -f.keys.length,
    f.rel.split(path.sep).length, // root over nested
    NAME_ORDER.indexOf(path.basename(f.rel)) === -1 ? 9 : NAME_ORDER.indexOf(path.basename(f.rel)),
  ] as const;

export function bestEnvFile(files: EnvFile[]): EnvFile | null {
  const cmp = (a: EnvFile, b: EnvFile) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return a.rel.localeCompare(b.rel);
  };
  return [...files].sort(cmp)[0] ?? null;
}

// ---------- frontend ----------

type Pkg = { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

export async function packageJsons(root: string, walk?: Walk): Promise<{ dir: string; pkg: Pkg }[]> {
  const out: { dir: string; pkg: Pkg }[] = [];
  for (const dir of await walkDirs(root, 2, walk)) {
    const pkg = readJsonFile<Pkg>(path.join(dir, "package.json"));
    if (pkg && typeof pkg === "object") out.push({ dir, pkg });
  }
  return out;
}

const deps = (p: Pkg) => ({ ...p.dependencies, ...p.devDependencies });
export function webFramework(p: Pkg): "next" | "vite" | "react-scripts" | "react" | null {
  const d = deps(p);
  if (d.next) return "next";
  if (d.vite) return "vite";
  if (d["react-scripts"]) return "react-scripts";
  if (d.react) return "react";
  return null;
}
const DEFAULT_PORT = { next: 3000, vite: 5173, "react-scripts": 3000, react: 3000 } as const;

const URL_KEYS = ["FRONTEND_URL", "NEXT_PUBLIC_SITE_URL", "NEXT_PUBLIC_APP_URL", "APP_URL", "SITE_URL", "BASE_URL", "PUBLIC_URL", "VITE_APP_URL"];
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/;

const asUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
};

export function portFromScript(script: string): number | null {
  const m = script.match(/(?:--port[=\s]+|(?:^|\s)-p\s+|PORT=)(\d{2,5})/);
  return m ? Number(m[1]) : null;
}

export async function probeUp(url: string, ms = 800): Promise<boolean> {
  const u = asUrl(url);
  if (!u) return false;
  const hosts = LOCAL_HOST.test(u.hostname) ? ["127.0.0.1", "localhost"] : [u.hostname];
  const tries = hosts.map(async (h) => {
    const t = new URL(u.href);
    t.hostname = h;
    try {
      await fetch(t.origin, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(ms) });
      return true;
    } catch {
      return false;
    }
  });
  return (await Promise.all(tries)).some(Boolean);
}

export function guessFrontend(envVars: Record<string, string>[], pkgs: { dir: string; pkg: Pkg }[]): Omit<FrontendGuess, "up"> | null {
  for (const k of URL_KEYS)
    for (const vars of envVars) {
      const u = vars[k] ? asUrl(vars[k]) : null;
      if (u && LOCAL_HOST.test(u.hostname)) return { url: `${u.protocol}//localhost${u.port ? `:${u.port}` : ""}`, source: k };
    }
  const web = pkgs.filter((p) => webFramework(p.pkg));
  for (const { pkg } of web) {
    const port = portFromScript(pkg.scripts?.dev ?? pkg.scripts?.start ?? "");
    if (port) return { url: `http://localhost:${port}`, source: "package.json dev script" };
  }
  const fw = web[0] && webFramework(web[0].pkg);
  if (fw) return { url: `http://localhost:${DEFAULT_PORT[fw]}`, source: `${fw} default` };
  return null;
}

// ---------- migrations ----------

const sqlCount = async (dir: string): Promise<number> => {
  let n = 0;
  for (const e of await readDir(dir)) {
    if (e.isFile() && e.name.endsWith(".sql")) n++;
    else if (e.isDirectory()) for (const f of await readDir(path.join(dir, e.name))) if (f.isFile() && f.name.endsWith(".sql")) n++; // prisma: <ts>_name/migration.sql
  }
  return n;
};

export async function findMigrations(root: string, walk?: Walk): Promise<Migrations | null> {
  const counts: Record<string, number> = {};
  for (const dir of await walkDirs(root, 4, walk)) {
    const rel = path.relative(root, dir);
    const base = path.basename(dir);
    if (!(base === "migrations" || base === "drizzle" || rel.endsWith(`db${path.sep}migrate`))) continue;
    const n = await sqlCount(dir);
    if (n > 0) counts[rel] = n;
  }
  const dirs = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.length - b.length || a.localeCompare(b));
  return dirs.length ? { dir: dirs[0], extra: dirs.slice(1), counts } : null;
}

// ---------- app hosts ----------

const THIRD_PARTY = new Set(
  ("supabase amazonaws aws googleapis google gstatic stripe slack linear openai anthropic vercel github githubusercontent " +
    "upstash sentry posthog segment mixpanel amplitude intercom twilio sendgrid mailgun resend postmarkapp cloudflare " +
    "cloudinary auth0 clerk firebaseio firebase herokuapp heroku netlify render railway fly azure microsoft windows " +
    "office live apple facebook meta instagram twitter x linkedin hubspot notion airtable zapier calendly zoom nylas " +
    "algolia pinecone mongodb redis neon planetscale datadoghq logtail betterstack loops paddle lemonsqueezy " +
    "gravatar youtube spotify cohere mistral groq together replicate huggingface perplexity deepgram elevenlabs " +
    "assemblyai pusher ably mapbox example localhost ngrok trycloudflare onrender modal browserbase exa serper tavily").split(/\s+/),
);

const MULTI_TLD = /^(co|com|net|org|gov|ac|edu)$/;

export function siteLabel(host: string): string | null {
  if (/^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return null;
  const parts = host.toLowerCase().split(".");
  const i = parts.length >= 3 && MULTI_TLD.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? parts.length - 3 : parts.length - 2;
  return parts[i] || null;
}

const OWN_KEY = /(API|BACKEND|SITE|APP|FRONTEND|BASE|PUBLIC|SERVER|WEBHOOK|CALLBACK|REDIRECT|DOMAIN|HOST|ORIGIN|URL)/;

// Labels of non-local hosts the app's own env points at. A label counts when URL-ish keys point at it
// at least twice (NYLAS_REDIRECT_URI + GOOGLE_REDIRECT_URI → app.foo.com), or it matches the repo/package name.
export function appHostsFrom(envVars: Record<string, string>[], names: string[]): string[] {
  const score = new Map<string, number>();
  const nameHit = (l: string) => names.some((n) => n.toLowerCase().replace(/[^a-z0-9]/g, "").includes(l));
  for (const vars of envVars)
    for (const [k, v] of Object.entries(vars)) {
      for (const raw of v.split(/[\s,]+/)) {
        const u = asUrl(raw);
        if (!u || LOCAL_HOST.test(u.hostname) || u.username || u.password) continue; // creds in a url: a db/redis dsn
        const l = siteLabel(u.hostname);
        if (!l || l.length < 3 || THIRD_PARTY.has(l)) continue;
        const named = nameHit(l);
        // CELLO_API_URL=https://api.cello.so: a key named after its host is an integration, not the app
        if (!named && k.toLowerCase().split("_").some((t) => t === l || (t.length >= 4 && l.startsWith(t)))) continue;
        score.set(l, (score.get(l) ?? 0) + (OWN_KEY.test(k) ? 1 : 0) + (named ? 3 : 0));
      }
    }
  return [...score.entries()].filter(([, s]) => s >= 2).sort((a, b) => b[1] - a[1]).map(([l]) => l).slice(0, 5);
}

// ---------- test logins ----------

const LOGIN_TAG = /(TEST|E2E|QA|PLAYWRIGHT|MOMENTIC)/;
const TAG_ONLY = /^(TEST|E2E|QA|PLAYWRIGHT|MOMENTIC)?$/;
// the key's last token names the field: TEST_USER_EMAIL, ACME_EMAIL, E2E_USERNAME — never USER_SERVICE_API_KEY
const USER_TOKEN = /^(EMAIL|USER|USERNAME|LOGIN)$/;
const PASS_TOKEN = /^(PASSWORD|PASS|PW|PWD)$/;
// a secret-ish word anywhere in the key disqualifies it, whatever it ends with
const NOT_LOGIN = /(^|_)(SECRET|TOKEN|KEY|API|CLIENT|DSN|URL|URI|HOST|PORT|ID|DB|DATABASE|REDIS|SMTP|MAIL_SERVER|POSTGRES|PG|MYSQL|MONGO)(_|$)/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME = /^[\w.+-]{1,64}$/;
const SECRETISH = /^(sk|pk|rk|ghp|gho|ghs|xox[abp]|AKIA|AIza|GOCSPX|eyJ)[-_]?/i;
const tokens = (k: string) => k.toUpperCase().split("_").filter(Boolean);
const last = (k: string) => tokens(k).at(-1) ?? "";
const stem = (k: string) => tokens(k).filter((t) => !USER_TOKEN.test(t) && !PASS_TOKEN.test(t)).join("_");

const isUserKey = (k: string) => USER_TOKEN.test(last(k)) && !NOT_LOGIN.test(k.toUpperCase());
const isPassKey = (k: string) => PASS_TOKEN.test(last(k)) && !NOT_LOGIN.test(k.toUpperCase());

// only values shaped like a login ever leave the server: an email, or a plain username (never a token)
export function loginValue(key: string, v: string | undefined): string | null {
  const s = v?.trim();
  if (!s) return null;
  if (EMAIL.test(s)) return s;
  return last(key) !== "EMAIL" && USERNAME.test(s) && !SECRETISH.test(s) && !/\d{6,}/.test(s) ? s : null;
}

// CI / automation accounts (momentic, playwright, +ci, bots): real but rarely what you browse as
export function isBotLogin(email: string): boolean {
  const [u, d = ""] = email.toLowerCase().split("@");
  return /\+(ci|bot|e2e|test|qa)\b/.test(u) || /(^|[._-])(ci|bot|e2e|automation|robot)([._-]|$)/.test(u) || /(momentic|playwright|cypress|mailinator|mailslurp)/.test(d);
}

export const loginId = (rel: string, userKey: string, passKey: string) =>
  crypto.createHash("sha256").update(`${rel}\0${userKey}\0${passKey}`).digest("hex").slice(0, 16);

type LoginHandle = LoginCandidate & { file: string; userKey: string; passKey: string };

export function loginsFrom(files: { path: string; rel: string; vars: Record<string, string> }[], loginUrl: LoginUrl = { url: "/login", source: null }): LoginHandle[] {
  const out: LoginHandle[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const keys = Object.keys(f.vars);
    // .env.test / .env.e2e / .env.momentic.local: every login in a test-tagged file counts
    const fileTagged = LOGIN_TAG.test(path.basename(f.rel).toUpperCase());
    const tagged = (k: string) => fileTagged || LOGIN_TAG.test(k.toUpperCase());
    const passKeys = keys.filter((k) => isPassKey(k) && f.vars[k] && tagged(k));
    for (const k of keys) {
      if (!tagged(k) || !isUserKey(k)) continue;
      const email = loginValue(k, f.vars[k]);
      if (!email) continue;
      // same stem (TEST_USER_EMAIL ↔ TEST_USER_PASSWORD), else a lone login-shaped one (PASSWORD, TEST_PASSWORD) — never DB_PASSWORD
      const single = passKeys.length === 1 && TAG_ONLY.test(stem(passKeys[0])) ? passKeys[0] : undefined;
      const pk = passKeys.find((p) => stem(p) === stem(k)) ?? single;
      if (seen.has(email)) continue; // same account in .env and .env.local: keep the first (best-ranked) file
      seen.add(email);
      const st = stem(k);
      const bot = isBotLogin(email);
      const name = !st || TAG_ONLY.test(st) ? "" : st.toLowerCase().replace(/_/g, " ");
      const label = bot ? `${name ? `${name} ` : ""}ci login` : name || "test account";
      out.push({
        id: loginId(f.rel, k, pk ?? ""),
        label,
        loginUrlGuess: loginUrl.url,
        loginUrlSource: loginUrl.source,
        email,
        hasPassword: Boolean(pk),
        bot,
        from: `${f.rel} · ${k}`,
        file: f.path,
        userKey: k,
        passKey: pk ?? "",
      });
    }
  }
  // people before bots, then ones we can actually sign in with; stable otherwise
  const rankOf = (l: LoginHandle) => (l.bot ? 2 : 0) + (l.hasPassword ? 0 : 1);
  return out.map((l, i) => [l, i] as const).sort((a, b) => rankOf(a[0]) - rankOf(b[0]) || a[1] - b[1]).map(([l]) => l).slice(0, 8);
}

// ---------- login route ----------

export type LoginUrl = { url: string; source: string | null }; // source null = a guess
const AUTH_SEG = /^(login|log-in|signin|sign-in)$/i;
const ROUTE_ROOT = /^(app|pages|routes)$/;
const PAGE_FILE = /^(login|log-in|signin|sign-in)\.(tsx|jsx|ts|js|vue|svelte|astro|mdx)$/i;

// route segments after the last app/ pages/ routes/ dir: route groups "(auth)" and slots "@x" vanish
function routeOf(rel: string[]): string[] | null {
  const i = rel.findLastIndex((p) => ROUTE_ROOT.test(p));
  if (i < 0) return null;
  const seg = rel.slice(i + 1).filter((p) => !/^\(.*\)$/.test(p) && !p.startsWith("@") && !p.startsWith("_"));
  if (seg.some((p) => p === "api" || p.startsWith("[") || p.startsWith("$") || p.startsWith(":"))) return null;
  return seg;
}

// Where the web app signs in: app/(auth)/login, src/pages/signin.tsx, routes/login … in the web package
// most likely to be "the" frontend (dev port matches, or named frontend/web/app/client, or the root).
export async function guessLoginUrl(root: string, pkgs: { dir: string; pkg: Pkg }[], frontendUrl: string | null): Promise<LoginUrl> {
  const port = frontendUrl ? asUrl(frontendUrl)?.port : "";
  const web = pkgs.filter((p) => webFramework(p.pkg));
  const pkgRank = (p: { dir: string; pkg: Pkg }) =>
    port && String(portFromScript(p.pkg.scripts?.dev ?? p.pkg.scripts?.start ?? "") ?? "") === port
      ? 0
      : p.dir === root || /^(frontend|web|app|client|www|site|webapp)$/i.test(path.basename(p.dir))
        ? 1
        : /admin|docs|storybook|email/i.test(path.basename(p.dir))
          ? 3
          : 2;
  for (const p of [...web].sort((a, b) => pkgRank(a) - pkgRank(b))) {
    const hits: { url: string; rel: string }[] = [];
    for (const dir of await walkDirs(p.dir, 5, undefined, 1500)) {
      const rel = path.relative(p.dir, dir).split(path.sep).filter(Boolean);
      const seg = routeOf(rel);
      if (seg === null) continue;
      if (seg.length && AUTH_SEG.test(seg.at(-1)!)) hits.push({ url: "/" + seg.join("/"), rel: path.relative(root, dir) });
      // pages/login.tsx, routes/signin.svelte
      if (rel.some((x) => x === "pages" || x === "routes"))
        for (const e of await readDir(dir))
          if (e.isFile() && PAGE_FILE.test(e.name)) hits.push({ url: "/" + [...seg, e.name.replace(/\.\w+$/, "")].join("/"), rel: path.relative(root, path.join(dir, e.name)) });
    }
    hits.sort((a, b) => a.url.split("/").length - b.url.split("/").length || a.url.length - b.url.length);
    if (hits[0]) return { url: hits[0].url, source: hits[0].rel };
  }
  return { url: "/login", source: null };
}

// Server-side only: resolve a candidate id back to its email + password by re-reading the repo.
export async function resolveLogin(repoPath: string, candidateId: string): Promise<{ label: string; email: string; password: string; loginUrl: string } | null> {
  const files = await envFilesIn(repoPath);
  const h = loginsFrom(files).find((l) => l.id === candidateId);
  if (!h) return null;
  const vars = files.find((f) => f.path === h.file)?.vars ?? {};
  const pkgs = await timeBox(packageJsons(repoPath), 1500, []);
  const login = await timeBox(guessLoginUrl(repoPath, pkgs, guessFrontend(files.map((f) => f.vars), pkgs)?.url ?? null), 1500, { url: "/login", source: null });
  return { label: h.label, email: h.email, password: h.passKey ? vars[h.passKey] ?? "" : "", loginUrl: login.url };
}

// ---------- the report ----------

export async function detectRepo(root: string, ctx: SetupCtx): Promise<RepoReport> {
  const walk: Walk = { partial: false };
  const files = await timeBox(envFilesIn(root, walk), 2000, []);
  const envFiles: EnvFile[] = files.map((f) => ({ path: f.path, rel: f.rel, keys: KNOWN_KEYS.filter((k) => f.vars[k]) }));
  const best = bestEnvFile(envFiles);
  // the chosen file's values win (it's what lambda will read), then the rest
  const ordered = [...files].sort((a, b) => (a.path === best?.path ? -1 : b.path === best?.path ? 1 : 0));
  const vars = ordered.map((f) => f.vars);
  const pkgs = await timeBox(packageJsons(root, walk), 1500, []);
  const fe = guessFrontend(vars, pkgs);
  const [up, migrations, loginUrl] = await Promise.all([
    fe && ctx.probe ? probeUp(fe.url) : Promise.resolve(null),
    timeBox(findMigrations(root, walk), 2000, null),
    timeBox(guessLoginUrl(root, pkgs, fe?.url ?? null), 1500, { url: "/login", source: null }),
  ]);
  const names = [path.basename(root), ...pkgs.map((p) => p.pkg.name ?? "")].filter(Boolean);
  return {
    path: root,
    name: path.basename(root),
    branch: gitBranch(root),
    envFiles,
    envPath: best?.path ?? null,
    frontend: fe ? { ...fe, up } : null,
    migrations,
    appHosts: appHostsFrom(vars, names),
    logins: loginsFrom(ordered, loginUrl).map(({ id, label, loginUrlGuess, loginUrlSource, email, hasPassword, bot, from }) => ({ id, label, loginUrlGuess, loginUrlSource, email, hasPassword, bot, from })),
    partial: walk.partial,
  };
}

export const hasWebFrontend = async (root: string) => (await packageJsons(root)).some((p) => webFramework(p.pkg));
