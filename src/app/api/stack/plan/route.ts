import { NextResponse } from "next/server";
import { editPlan, mainWorktree, planStack } from "@/lib/stack";
import { errorResponse, jsonBody, repoFrom, stackView } from "@/lib/stack/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

// POST {repo?, wait?} -> re-plan with a Claude Code session (read-only). Background by default (202 +
// view with planning: true); wait: true answers once the plan (or planError) is stored.
export async function POST(req: Request) {
  try {
    const body = await jsonBody(req);
    const repo = repoFrom(body.repo);
    const wt = await mainWorktree(repo);
    const run = planStack(repo, wt);
    if (body.wait === true) await run;
    else run.catch(() => undefined);
    return NextResponse.json(await stackView(repo), { status: body.wait === true ? 200 : 202 });
  } catch (e) {
    return errorResponse(e);
  }
}

// PUT {repo?, plan} -> validate + store the developer's edit (unapproved again)
export async function PUT(req: Request) {
  try {
    const body = await jsonBody(req);
    const repo = repoFrom(body.repo);
    if (!body.plan || typeof body.plan !== "object") return NextResponse.json({ error: "plan required" }, { status: 400 });
    editPlan(repo, body.plan);
    return NextResponse.json(await stackView(repo));
  } catch (e) {
    return errorResponse(e);
  }
}
