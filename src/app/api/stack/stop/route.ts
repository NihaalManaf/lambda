import { NextResponse } from "next/server";
import { mainWorktree, stopStack } from "@/lib/stack";
import { errorResponse, jsonBody, repoFrom, serviceFrom } from "@/lib/stack/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST {repo?, service?} -> stop the stack (or one service): SIGTERM its process group, SIGKILL after 5s
export async function POST(req: Request) {
  try {
    const body = await jsonBody(req);
    const repo = repoFrom(body.repo);
    const wt = await mainWorktree(repo);
    return NextResponse.json({ state: await stopStack(wt, serviceFrom(body.service)) });
  } catch (e) {
    return errorResponse(e);
  }
}
