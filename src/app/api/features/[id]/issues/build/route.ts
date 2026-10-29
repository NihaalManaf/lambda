import { NextResponse } from "next/server";
import { buildFromIssues } from "@/lib/issues";
import { getFeature } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

// POST {issueIds} -> {id}: a new build feature started from these open issues (they move to "in build")
export async function POST(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  if (!getFeature(fid)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as { issueIds?: unknown };
  const ids = Array.isArray(b.issueIds) ? b.issueIds.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
  if (!ids.length) return NextResponse.json({ error: "issueIds required" }, { status: 400 });
  try {
    const f = await buildFromIssues(fid, ids);
    return NextResponse.json({ id: f.id });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "build failed" }, { status: 400 });
  }
}
