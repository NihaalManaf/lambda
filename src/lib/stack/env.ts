import fs from "node:fs";
import path from "node:path";
import { LOADER_ENV } from "./plan";

// Env plumbing for the stack: copy the developer's gitignored env files into lambda's worktree (never the
// other way), build each service's process env, and redact secrets out of captured logs.

const inside = (root: string, p: string) => {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

export type CopyResult = { file: string; status: "copied" | "current" | "missing" | "removed" };

// Copies each relative env file repo → worktree when the worktree copy is missing or differs. 0600.
// Reads only from the repo; refuses paths that escape either root (symlinked files are followed for reading,
// but must resolve inside the repo).
export function copyEnvFiles(repo: string, worktree: string, files: string[]): CopyResult[] {
  const out: CopyResult[] = [];
  const realRepo = fs.realpathSync(repo);
  for (const rel of files) {
    const src = path.resolve(realRepo, rel);
    const dst = path.resolve(worktree, rel);
    if (!inside(realRepo, src) || !inside(worktree, dst)) throw new Error(`env file ${rel} is outside the repo`);
    let real: string;
    try {
      real = fs.realpathSync(src);
    } catch {
      // gone from the developer's checkout: drop lambda's old copy too, or the services keep reading it
      let had = false;
      try {
        fs.lstatSync(dst);
        had = true;
      } catch {}
      if (had) fs.rmSync(dst, { force: true });
      out.push({ file: rel, status: had ? "removed" : "missing" });
      continue;
    }
    if (!inside(realRepo, real) || !fs.statSync(real).isFile()) throw new Error(`env file ${rel} is outside the repo`);
    const data = fs.readFileSync(real);
    let cur: Buffer | null = null;
    try {
      if (fs.lstatSync(dst).isSymbolicLink()) fs.rmSync(dst); // never write through a link
      else cur = fs.readFileSync(dst);
    } catch {
      /* missing */
    }
    if (cur && cur.equals(data)) {
      fs.chmodSync(dst, 0o600);
      out.push({ file: rel, status: "current" });
      continue;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const tmp = `${dst}.lambda-${process.pid}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, dst);
    out.push({ file: rel, status: "copied" });
  }
  return out;
}

// KEY=value pairs from a dotenv file (enough for redaction; not a full dotenv parser)
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

const SECRET_KEY = /key|secret|token|pass|pwd|auth|dsn|private|signing|credential|cookie|session|(database|redis|db|mongo|postgres|supabase)_?url/i;
const BORING = /^(true|false|yes|no|on|off|null|none|development|production|test|local|staging|\d{1,6})$/i;

// values worth redacting from env files: secret-looking keys, or anything long and opaque
export function secretValues(vars: Record<string, string>): string[] {
  return Object.entries(vars)
    .filter(([k, v]) => v.length >= 6 && !BORING.test(v) && (SECRET_KEY.test(k) || (v.length >= 20 && !/\s/.test(v))))
    .filter(([, v]) => !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(v))
    .map(([, v]) => v);
}

export function envFileSecrets(repo: string, files: string[]): string[] {
  const out: string[] = [];
  for (const rel of files) {
    try {
      out.push(...secretValues(parseDotenv(fs.readFileSync(path.resolve(repo, rel), "utf8"))));
    } catch {
      /* missing */
    }
  }
  return out;
}

const PATTERNS: [RegExp, string][] = [
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "•••jwt"],
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/g, "•••"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "•••"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})/g, "•••"],
  [/\b(AKIA[0-9A-Z]{16})\b/g, "•••"],
  [/(bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, "$1•••"],
  [/((?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, "$1•••"],
  [/(\/\/[^/\s:@]+:)[^@\s/]{3,}@/g, "$1•••@"], // creds in connection strings
];

// literal secrets (and their url/json-escaped forms) + common token shapes
export function redactor(secrets: string[]) {
  const list = [
    ...new Set(secrets.filter((s) => s && s.length >= 6).flatMap((s) => [s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1)])),
  ].sort((a, b) => b.length - a.length);
  return (line: string) => {
    let out = list.reduce((acc, s) => acc.split(s).join("•••"), line);
    for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
    return out;
  };
}

// The stack's processes get an allowlisted env, not lambda's whole env: an inherited API_URL / DATABASE_URL /
// NEXT_PUBLIC_* would beat the copied env files (process env wins in dotenv and next), and lambda's own
// tokens have no business in the developer's app. Plan extras can't set loader keys (see LOADER_ENV).
const KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TMPDIR|TERM|COLORTERM|TZ|SSH_AUTH_SOCK|__CF_USER_TEXT_ENCODING|XDG_[A-Z_]+|NVM_DIR|NVM_BIN|PYENV_ROOT|ASDF_DIR|ASDF_DATA_DIR|VOLTA_HOME|PNPM_HOME|BUN_INSTALL|HOMEBREW_PREFIX|HOMEBREW_CELLAR|HOMEBREW_REPOSITORY|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|ALL_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/;

export function serviceEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (KEEP.test(k) && v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(extra)) if (!LOADER_ENV.test(k)) env[k] = v;
  env.BROWSER = "none"; // dev servers must not pop a browser tab
  env.FORCE_COLOR = "0";
  return env as NodeJS.ProcessEnv;
}

// ---------- env-file values still pointing at the developer's own servers ----------

export type LocalRef = { file: string; key: string; port: number };
const LOCAL_URL = /(?:^|[/@\s"'=])(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\b/i;

// keys in the developer's env files whose value points at a localhost port (names + ports only, never values)
export function localhostKeys(repo: string, files: string[]): LocalRef[] {
  const out: LocalRef[] = [];
  for (const rel of files) {
    let text = "";
    try {
      text = fs.readFileSync(path.resolve(repo, rel), "utf8");
    } catch {
      continue;
    }
    for (const [key, v] of Object.entries(parseDotenv(text))) {
      const m = v.match(LOCAL_URL);
      if (m) out.push({ file: rel, key, port: Number(m[1]) });
    }
  }
  return out;
}

// the ones the plan doesn't override for any service whose cwd holds that env file: these still call the
// developer's own servers from inside lambda's stack
export function unwiredLocalRefs(
  repo: string,
  plan: { envFiles: string[]; env: Record<string, Record<string, string>>; services: { name: string; cwd: string; port?: { env?: string } }[] },
  ownPorts: number[] = [],
): LocalRef[] {
  const norm = (d: string) => (d === "." || !d ? "" : d.replace(/\/+$/, ""));
  return localhostKeys(repo, plan.envFiles).filter((r) => {
    if (ownPorts.includes(r.port)) return false;
    const dir = norm(path.dirname(r.file));
    const users = plan.services.filter((s) => {
      const c = norm(s.cwd);
      return c === dir || c.startsWith(dir ? `${dir}/` : "") || dir.startsWith(c ? `${c}/` : "");
    });
    const pool = users.length ? users : plan.services;
    return !pool.some((s) => r.key in (plan.env[s.name] ?? {}) || s.port?.env === r.key);
  });
}
