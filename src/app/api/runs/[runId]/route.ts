import { NextResponse } from "next/server";
import { getFeature, listFeatures } from "@/lib/store";
import type { Run } from "@/lib/runs";
import { reapIfLost } from "@/lib/verify";

type Ctx = { params: Promise<{ runId: string }> };

// Poll one run. ?feature=<id> skips the scan.
export async function GET(req: Request, { params }: Ctx) {
  const { runId } = await params;
  const fid = new URL(req.url).searchParams.get("feature");
  const features = fid ? [getFeature(fid)].filter((f) => !!f) : listFeatures();
  for (const f of features) {
    const run = f.runs.find((r) => r.id === runId) as Run | undefined;
    if (run) return NextResponse.json(await reapIfLost(f.id, run));
  }
  return NextResponse.json({ error: "not found" }, { status: 404 });
}
