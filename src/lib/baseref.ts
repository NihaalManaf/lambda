import path from "node:path";

// Pure helpers for settings.baseBranch (the branch lambda reads code from). No git here: intake.ts runs it.

// a ref name safe to hand git as an argument: never an option (-x), no ranges (..), no reflog (@{), no
// empty path segment, no trailing / or .lock. "" is allowed by the settings route (= auto-detect).
const BASE = /^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*\/\/)(?!.*\/$)(?!.*\.lock$)(?!.*\/-)[\w./-]{1,200}$/;
export const validBaseBranch = (s: string) => BASE.test(s);

export type BaseSpec = { kind: "remote"; remote: string; branch: string; name: string } | { kind: "local"; name: string };

// "origin/staging" → remote origin, branch staging — only when the first segment is a real remote (local
// branch names may hold slashes too, e.g. feature/x). Anything else is a local ref: read as-is, no fetch.
export function parseBase(setting: string, remotes: string[]): BaseSpec | null {
  const s = setting.trim();
  if (!validBaseBranch(s)) return null;
  const i = s.indexOf("/");
  if (i > 0 && i < s.length - 1 && remotes.includes(s.slice(0, i))) return { kind: "remote", remote: s.slice(0, i), branch: s.slice(i + 1), name: s };
  return { kind: "local", name: s };
}

// build-mode features get their own checkout next to the shared one. The "-f-" infix keeps it clear of
// stack's `${shared}-<hash6>` branch checkouts.
export function featureDirName(sharedDir: string, fid: string): string {
  if (!/^[\w-]{1,64}$/.test(fid)) throw new Error("bad feature id");
  return `${sharedDir}-f-${fid}`;
}

// a dir lambda may remove: directly inside its worktrees dir, and never the shared checkout
export const removableFeatureDir = (dir: string, worktreesDir: string, sharedDir: string) =>
  path.dirname(dir) === worktreesDir && dir !== sharedDir && /-f-[\w-]+$/.test(path.basename(dir));

// fetch throttle: at most one fetch per repo + ref every `ms` (a turn shouldn't hit the network each time)
export const FETCH_EVERY_MS = 60_000;
export function shouldFetch(last: Map<string, number>, key: string, at = Date.now(), ms = FETCH_EVERY_MS): boolean {
  const t = last.get(key);
  return t === undefined || at - t >= ms;
}
