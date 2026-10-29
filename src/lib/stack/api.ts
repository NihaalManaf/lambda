import "server-only";
import fs from "node:fs";
import { NextResponse } from "next/server";
import { getSettings } from "../store";
import { unwiredLocalRefs } from "./env";
import { getPlanRecord, isPlanning, mainWorktree, planHash, reapOrphans, stackState, touchStack } from "./index";
import { planWarnings } from "./plan";

// Shared bits of the /api/stack routes. The repo is always the configured one: `repo` (query or body) is
// accepted only when it names that repo, so these routes can't be pointed at some other checkout.

export class RepoError extends Error {}

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

export function repoFrom(asked?: unknown): string {
  const repo = getSettings().repoPath;
  if (!repo) throw new RepoError("no repo configured — set it in settings");
  if (typeof asked === "string" && asked.trim() && real(asked.trim()) !== real(repo)) throw new RepoError("repo must be the configured repo");
  return repo;
}

export const jsonBody = async (req: Request): Promise<Record<string, unknown>> => {
  const b = (await req.json().catch(() => null)) as unknown;
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
};

export const serviceFrom = (v: unknown) => (typeof v === "string" && /^[\w-]{1,32}$/.test(v) ? v : undefined);

export function errorResponse(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  const status = e instanceof RepoError ? 400 : /not approved|isn.t approved|no stack plan|no service|validate|must be|invalid|plan changed/i.test(message) ? 409 : 500;
  return NextResponse.json({ error: message.slice(0, 400) }, { status });
}

// what the approval sheet must show besides the plan: its hash (sent back with approve), warnings, and env-file
// keys still pointing at the developer's own servers (names + ports only)
export function planExtras(repo: string, record: ReturnType<typeof getPlanRecord>) {
  const plan = record?.plan;
  if (!plan) return { planHash: null, warnings: [] as string[], localRefs: [] as { file: string; key: string; port: number }[] };
  let localRefs: { file: string; key: string; port: number }[] = [];
  try {
    localRefs = unwiredLocalRefs(repo, plan);
  } catch {}
  return { planHash: planHash(plan), warnings: planWarnings(plan), localRefs };
}

// GET payload: the plan record + whether it's being planned + the main worktree's stack state.
// touch: the caller is looking at the stack (keeps it from the idle reaper)
export async function stackView(repo: string, opts: { touch?: boolean } = {}) {
  await reapOrphans().catch(() => undefined);
  const record = getPlanRecord(repo);
  let worktree: string | null = null;
  try {
    worktree = await mainWorktree(repo);
  } catch {}
  if (worktree && opts.touch) touchStack(worktree);
  return { repo, record, ...planExtras(repo, record), planning: isPlanning(repo), worktree, state: worktree ? stackState(worktree) : null };
}
