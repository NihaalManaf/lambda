import { NextResponse } from "next/server";
import { IntakeBusyError, refreshFeatureWorktree } from "@/lib/intake";
import { pieceView } from "@/lib/pieces";
import { getFeature } from "@/lib/store";
import { featureMode } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

// POST -> { feature, sha, base, moved, status? }: a build feature's checkout moved to the freshly fetched base
// tip and re-pinned. 409 while lambda is reading it.
export async function POST(_: Request, { params }: Ctx) {
  const fid = (await params).id;
  const f = getFeature(fid);
  if (!f) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (featureMode(f) !== "build") return NextResponse.json({ error: "only build features have their own checkout" }, { status: 409 });
  try {
    const r = await refreshFeatureWorktree(fid);
    const next = getFeature(fid);
    return NextResponse.json({ ...r, feature: next ? pieceView(next) : null });
  } catch (e) {
    const busy = e instanceof IntakeBusyError;
    return NextResponse.json({ error: busy ? "lambda is reading the code — try again in a moment" : e instanceof Error ? e.message : String(e) }, { status: busy ? 409 : 422 });
  }
}
