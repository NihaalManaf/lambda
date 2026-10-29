import { NextResponse } from "next/server";
import { mapJourney } from "@/lib/journey";
import { pieceIdFrom } from "@/lib/pieces";
import { getFeature } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };

// POST {pieceId} -> the piece's view with journey steps named and every story placed in one (src/lib/journey.ts)
export async function POST(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const f = getFeature(fid);
  if (!f) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { pieceId?: string };
  const pid = pieceIdFrom(req.url, body) || f.pieces[0]?.id;
  if (!pid) return NextResponse.json({ error: "no piece" }, { status: 400 });
  try {
    return NextResponse.json(await mapJourney(fid, pid));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
