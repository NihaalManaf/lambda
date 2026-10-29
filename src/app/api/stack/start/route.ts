import { NextResponse } from "next/server";
import { ensureStack, getPlanRecord, mainWorktree, stackState } from "@/lib/stack";
import { errorResponse, jsonBody, repoFrom, serviceFrom } from "@/lib/stack/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

// POST {repo?, service?, wait?} -> start the approved stack (or one service) in the main worktree.
// Answers right away with the starting state unless wait: true (then once everything is ready / failed).
export async function POST(req: Request) {
  try {
    const body = await jsonBody(req);
    const repo = repoFrom(body.repo);
    const service = serviceFrom(body.service);
    const wt = await mainWorktree(repo);
    const run = ensureStack(wt, getPlanRecord(repo), service ? { services: [service] } : {});
    if (body.wait === true) return NextResponse.json({ state: await run });
    // surface an immediate refusal (not approved, foreign owner) instead of a silent background failure
    const early = await Promise.race([run.then((s) => ({ s }), (e: unknown) => ({ e })), new Promise<null>((r) => setTimeout(() => r(null), 400))]);
    if (early && "e" in early) throw early.e;
    run.catch(() => undefined);
    return NextResponse.json({ state: early?.s ?? stackState(wt) }, { status: early ? 200 : 202 });
  } catch (e) {
    return errorResponse(e);
  }
}
