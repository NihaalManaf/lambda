import { NextResponse } from "next/server";
import { getTopology } from "@/lib/queues/cache";
import { domainGraph } from "@/lib/queues/graph";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ domain: string }> };

// GET ?part= -> QueueGraph (<= 14 nodes; parts when bigger)
export async function GET(req: Request, { params }: Ctx) {
  const { domain } = await params;
  const t = getTopology();
  if (!t) return NextResponse.json({ error: "no scan yet" }, { status: 404 });
  const g = domainGraph(t, decodeURIComponent(domain), new URL(req.url).searchParams.get("part") ?? undefined);
  return g ? NextResponse.json(g) : NextResponse.json({ error: "unknown domain" }, { status: 404 });
}
