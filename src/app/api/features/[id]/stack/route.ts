import { NextResponse } from "next/server";
import { ensureStack, featureWorktree, getPlanRecord, isPlanning, reapOrphans, stackState, touchStack } from "@/lib/stack";
import { errorResponse, repoFrom } from "@/lib/stack/api";
import { getFeature } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

type Ctx = { params: Promise<{ id: string }> };

// GET -> { worktree, approved, planning, state } for the stack serving this feature's worktree
export async function GET(_: Request, { params }: Ctx) {
  const fid = (await params).id;
  if (!getFeature(fid)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const repo = repoFrom();
    await reapOrphans().catch(() => undefined);
    const worktree = await featureWorktree(fid);
    const record = getPlanRecord(repo);
    if (worktree) touchStack(worktree, fid); // the feature page is open: not idle
    return NextResponse.json({ worktree, approved: !!record?.approved, hasPlan: !!record?.plan, planning: isPlanning(repo), state: worktree ? stackState(worktree) : null });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST -> start (background) the approved stack for this feature's worktree; answers with the starting state
export async function POST(_: Request, { params }: Ctx) {
  const fid = (await params).id;
  if (!getFeature(fid)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const repo = repoFrom();
    const worktree = await featureWorktree(fid);
    if (!worktree) return NextResponse.json({ error: "no checkout for this feature" }, { status: 409 });
    const run = ensureStack(worktree, getPlanRecord(repo), { featureId: fid });
    const early = await Promise.race([run.then((s) => ({ s }), (e: unknown) => ({ e })), new Promise<null>((r) => setTimeout(() => r(null), 400))]);
    if (early && "e" in early) throw early.e;
    run.catch(() => undefined);
    return NextResponse.json({ worktree, state: early?.s ?? stackState(worktree) }, { status: early ? 200 : 202 });
  } catch (e) {
    return errorResponse(e);
  }
}
