import { NextResponse } from "next/server";
import { getPlanRecord, mainWorktree, restartStack, stackState } from "@/lib/stack";
import { errorResponse, jsonBody, repoFrom, serviceFrom } from "@/lib/stack/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

// POST {repo?, service?, wait?} -> restart the stack (or one service) on the same ports when still free
export async function POST(req: Request) {
  try {
    const body = await jsonBody(req);
    const repo = repoFrom(body.repo);
    const wt = await mainWorktree(repo);
    const run = restartStack(wt, getPlanRecord(repo), serviceFrom(body.service));
    if (body.wait === true) return NextResponse.json({ state: await run });
    const early = await Promise.race([run.then((s) => ({ s }), (e: unknown) => ({ e })), new Promise<null>((r) => setTimeout(() => r(null), 400))]);
    if (early && "e" in early) throw early.e;
    run.catch(() => undefined);
    return NextResponse.json({ state: early?.s ?? stackState(wt) }, { status: early ? 200 : 202 });
  } catch (e) {
    return errorResponse(e);
  }
}
