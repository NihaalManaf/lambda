import { NextResponse } from "next/server";
import { getStatus, getTopology, isStale } from "@/lib/queues/cache";
import { overview } from "@/lib/queues/graph";

export const runtime = "nodejs";

// GET -> {status, overview, stats}. The client polls this every 1s while a scan runs.
export async function GET() {
  const t = getTopology();
  const count = (l: string) => t?.risks.filter((r) => r.level === l).length ?? 0;
  return NextResponse.json({
    status: getStatus(),
    overview: t ? overview(t) : null,
    stats: t && {
      files: t.files, producers: t.producers.length, channels: t.channels.length, consumers: t.consumers.length, edges: t.edges.length,
      risks: { bad: count("bad"), warn: count("warn"), info: count("info") }, unresolved: t.unresolved, scannedAt: t.scannedAt, stale: isStale(),
    },
  });
}
