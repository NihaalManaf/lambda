import { NextResponse } from "next/server";
import { mainWorktree, stackLogs } from "@/lib/stack";
import { errorResponse, repoFrom, serviceFrom } from "@/lib/stack/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?repo&service&since -> { lines: [{seq, at, service, stream, line}], last } — redacted, newest last.
// Poll with since = the previous `last`. service "setup" = env copy + setup steps.
export async function GET(req: Request) {
  try {
    const q = new URL(req.url).searchParams;
    const repo = repoFrom(q.get("repo"));
    const wt = await mainWorktree(repo);
    const since = Math.max(0, Number(q.get("since")) || 0);
    return NextResponse.json(stackLogs(wt, since, serviceFrom(q.get("service"))));
  } catch (e) {
    return errorResponse(e);
  }
}
