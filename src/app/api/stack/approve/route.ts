import { NextResponse } from "next/server";
import { approvePlan } from "@/lib/stack";
import { errorResponse, jsonBody, repoFrom, stackView } from "@/lib/stack/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST {repo?, approved?: boolean = true, planHash} -> approve (or withdraw approval of) the stored plan.
// Approving needs the planHash of the plan the developer was shown (from GET /api/stack); 409 when the stored
// plan is a different one by now.
export async function POST(req: Request) {
  try {
    const body = await jsonBody(req);
    const repo = repoFrom(body.repo);
    approvePlan(repo, body.approved !== false, typeof body.planHash === "string" ? body.planHash : undefined);
    return NextResponse.json(await stackView(repo));
  } catch (e) {
    return errorResponse(e);
  }
}
