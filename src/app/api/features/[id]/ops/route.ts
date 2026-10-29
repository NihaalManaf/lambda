import { NextResponse } from "next/server";
import { applyOps, isKnownOp } from "@/lib/chat";
import { pieceIdFrom } from "@/lib/pieces";
import { getFeature } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 300; // refine_chart / draw_lens / rediscover call the model

type Ctx = { params: Promise<{ id: string }> };

// POST {ops: FeatureOp[], pieceId?} -> {feature: pieceView, notes}. Atomic: one bad op and nothing is written.
// Ops edit pieceId (or ?piece=; default: first piece).
export async function POST(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  if (!getFeature(fid)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { ops?: unknown; pieceId?: unknown } | null;
  const ops = body?.ops;
  if (!Array.isArray(ops) || !ops.length || ops.length > 50) return NextResponse.json({ error: "ops: 1-50 ops" }, { status: 400 });
  const bad = ops.findIndex((o) => !isKnownOp(o));
  if (bad >= 0) return NextResponse.json({ error: `ops[${bad}]: unknown op` }, { status: 400 });
  try {
    return NextResponse.json(await applyOps(fid, ops, undefined, pieceIdFrom(req.url, body)));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
  }
}
