import { NextResponse } from "next/server";
import { undoTurn } from "@/lib/chat";
import { pieceIdFrom, pieceView } from "@/lib/pieces";
import { getFeature } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// POST -> feature with the last chat turn's changes rolled back (409 if something changed since)
export async function POST(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  if (!getFeature(fid)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    return NextResponse.json(pieceView(await undoTurn(fid), pieceIdFrom(req.url)));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}
