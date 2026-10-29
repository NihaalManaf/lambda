import "server-only";
import fs from "node:fs";
import path from "node:path";
import { isDir, isFile, readDir, readText, safePath, SKIP_DIRS, timeBox, type SetupCtx } from "./ctx";
import { gitBranch, hasWebFrontend } from "./repo";

// Which repo is "your app"? Mostly: where you run Claude Code, weighted by recency. Plus a shallow
// scan of the usual code folders so a fresh machine still gets candidates.

export type RepoCandidate = {
  path: string;
  name: string;
  sessions: number;
  lastUsed: string | null; // ISO
  web: boolean;
  branch: string | null;
  score: number;
};

const SCAN_ROOTS = ["Documents", "code", "dev", "src", "projects", "Developer", "work"];
const MARKERS = ["package.json", "pyproject.toml", "requirements.txt"];
const HALF_LIFE_DAYS = 14;

const inside = (p: string, root: string) => p === root || p.startsWith(root + path.sep);

// <repo>/.worktrees/<x>/..., <repo>/.claude/worktrees/<x>/... → <repo>
export function stripWorktree(p: string): string {
  const m = p.match(/^(.*?)\/(?:\.worktrees|\.claude\/worktrees)\/[^/]+/);
  return m ? m[1] : p;
}

// Walk up to the git root. A linked worktree's `.git` is a file ("gitdir: <repo>/.git/worktrees/x"):
// follow it back to the main checkout. Pure fs — no git spawn per session dir.
export function repoRootOf(cwd: string, home: string): string | null {
  let p = stripWorktree(path.resolve(cwd)); // '/Users/x/../../opt/app' must not pass inside() as written
  if (!inside(p, home)) return null;
  while (!fs.existsSync(p) && inside(p, home) && p !== home) p = path.dirname(p);
  for (let dir = p; inside(dir, home) && dir !== home; dir = path.dirname(dir)) {
    const g = path.join(dir, ".git");
    if (isDir(g)) return dir;
    if (isFile(g)) {
      const gitdir = readText(g, 1024).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
      const common = gitdir && path.resolve(dir, gitdir).match(/^(.*)\/\.git(\/|$)/)?.[1];
      // a worktree of a repo outside home (e.g. /Volumes/SSD/app) stays the worktree itself
      return common && inside(common, home) && common !== home ? common : dir;
    }
  }
  // not a git repo: still a project if it has a marker
  return MARKERS.some((m) => isFile(path.join(p, m))) && p !== home ? p : null;
}

// session cwd from the head of a transcript (the encoded dir name is lossy: '-' vs '/')
function sessionCwd(file: string): string | null {
  const head = readText(file, 64 * 1024);
  return head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)+)"/)?.[1]?.replace(/\\(.)/g, "$1") ?? null;
}

type Usage = { sessions: number; last: number; score: number };

async function sessionUsage(ctx: SetupCtx): Promise<Map<string, Usage>> {
  const byRoot = new Map<string, Usage>();
  for (const d of await readDir(ctx.projectsDir)) {
    if (!d.isDirectory()) continue;
    const dir = path.join(ctx.projectsDir, d.name);
    const files = (await readDir(dir))
      .filter((f) => f.isFile() && f.name.endsWith(".jsonl"))
      .map((f) => {
        const p = path.join(dir, f.name);
        try {
          return { p, st: fs.statSync(p) };
        } catch {
          return null;
        }
      })
      .filter((x): x is { p: string; st: fs.Stats } => !!x && x.st.size > 0)
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    if (!files.length) continue;
    let cwd: string | null = null;
    for (const f of files.slice(0, 3)) if ((cwd = sessionCwd(f.p))) break;
    if (cwd) cwd = path.resolve(cwd);
    if (!cwd || !inside(cwd, ctx.home) || cwd === ctx.home) continue;
    const root = repoRootOf(cwd, ctx.home);
    if (!root) continue;
    const u = byRoot.get(root) ?? { sessions: 0, last: 0, score: 0 };
    for (const f of files) {
      const age = Math.max(0, ctx.now - f.st.mtimeMs) / 86_400_000;
      u.score += 0.5 ** (age / HALF_LIFE_DAYS);
      u.sessions++;
      u.last = Math.max(u.last, f.st.mtimeMs);
    }
    byRoot.set(root, u);
  }
  return byRoot;
}

// git roots with a project marker, depth ≤3 under the usual code folders
async function scanRepos(ctx: SetupCtx, deadline: number): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (Date.now() > deadline || out.length > 200) return;
    if (isDir(path.join(dir, ".git")) && MARKERS.some((m) => isFile(path.join(dir, m)))) {
      out.push(dir);
      return; // don't descend into repos
    }
    if (depth <= 0) return;
    for (const e of await readDir(dir))
      if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) await walk(path.join(/*turbopackIgnore: true*/ dir, e.name), depth - 1);
  };
  for (const r of SCAN_ROOTS) await walk(path.join(/*turbopackIgnore: true*/ ctx.home, r), 3);
  return out;
}

export async function rankRepos(ctx: SetupCtx, limit = 5): Promise<RepoCandidate[]> {
  const deadline = Date.now() + 2500;
  const [usage, scanned] = await Promise.all([
    timeBox(sessionUsage(ctx), 3000, new Map<string, Usage>()),
    timeBox(scanRepos(ctx, deadline), 3000, [] as string[]),
  ]);
  let self = ctx.selfDir;
  try {
    self = fs.realpathSync(self);
  } catch {}
  const roots = new Set([...usage.keys(), ...scanned]);
  const rows: Omit<RepoCandidate, "web">[] = [];
  for (const root of roots) {
    if (inside(self, root) || inside(root, self)) continue; // lambda itself
    if (!safePath(root, ctx.home, "dir")) continue; // same rule apply() enforces: real, existing, inside home
    const u = usage.get(root);
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(root, ".git")).mtimeMs; // recent git activity, for repos without sessions
    } catch {}
    const age = Math.max(0, ctx.now - mtime) / 86_400_000;
    rows.push({
      path: root,
      name: path.basename(root),
      sessions: u?.sessions ?? 0,
      lastUsed: u ? new Date(u.last).toISOString() : null,
      branch: gitBranch(root),
      score: (u?.score ?? 0) + 0.05 * 0.5 ** (age / HALF_LIFE_DAYS),
    });
  }
  rows.sort((a, b) => b.score - a.score || b.sessions - a.sessions);
  const top = rows.slice(0, limit);
  const web = await Promise.all(top.map((r) => timeBox(hasWebFrontend(r.path), 800, false)));
  return top.map((r, i) => ({ ...r, web: web[i], score: Math.round(r.score * 100) / 100 }));
}

// Clearly yours: real session history, and well ahead of the runner-up.
export function dominant(c: RepoCandidate[]): RepoCandidate | null {
  const [a, b] = c;
  if (!a) return null;
  if (!b) return a;
  return a.sessions >= 3 && a.score >= 2 * b.score ? a : null;
}
