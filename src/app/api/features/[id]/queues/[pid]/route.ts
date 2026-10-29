import { NextResponse } from "next/server";
import { proposalGraph } from "@/lib/queues/propose";
import { getFeature } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string; pid: string }> };

// GET -> QueueGraph & {stale}: touched domains with diff states, context faded
export async function GET(_req: Request, { params }: Ctx) {
  const { id, pid } = await params;
  const p = getFeature(id)?.pieces.flatMap((x) => x.queues ?? []).find((x) => x.id === pid);
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    return NextResponse.json(await proposalGraph(p));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "preview failed" }, { status: 500 });
  }
}
