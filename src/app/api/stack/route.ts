import { NextResponse } from "next/server";
import { errorResponse, repoFrom, stackView } from "@/lib/stack/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?repo -> { repo, record: StackPlanRecord | null, planHash, warnings, localRefs, planning, worktree, state: StackState | null }
export async function GET(req: Request) {
  try {
    const repo = repoFrom(new URL(req.url).searchParams.get("repo"));
    return NextResponse.json(await stackView(repo, { touch: true }));
  } catch (e) {
    return errorResponse(e);
  }
}
