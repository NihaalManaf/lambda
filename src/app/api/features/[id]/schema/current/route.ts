import { NextResponse } from "next/server";
import { findPiece, pieceIdFrom, pieceView } from "@/lib/pieces";
import { focusView, pickFocus } from "@/lib/schema/focus";
import { current } from "@/lib/schema/replay";
import { getFeature, updateFeature } from "@/lib/store";
import type { SchemaFocus } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };
const err = (error: string, status = 400) => NextResponse.json({ error }, { status });

// The tables a piece uses today, at head (understand mode's schema tab). The pick is stored on the piece;
// GET picks once if there is none, POST re-picks. -> FocusView & {focus}
async function respond(req: Request, fid: string, repick: boolean) {
  const stored = getFeature(fid);
  if (!stored) return err("not found", 404);
  const pid = pieceIdFrom(req.url);
  const piece = findPiece(stored, pid) ?? stored.pieces[0];
  if (!piece) return err("piece not found", 404);
  try {
    const r = await current();
    let focus: SchemaFocus | undefined = repick ? undefined : piece.schemaFocus;
    if (!focus) {
      focus = await pickFocus(pieceView(stored, piece.id), r);
      const f = focus;
      await updateFeature(fid, (x) => {
        const p = x.pieces.find((y) => y.id === piece.id);
        if (p) p.schemaFocus = f;
      });
    }
    return NextResponse.json({ ...focusView(r, focus), focus });
  } catch (e) {
    return err(e instanceof Error ? e.message : "schema replay failed", 500);
  }
}

export async function GET(req: Request, { params }: Ctx) {
  return respond(req, (await params).id, false);
}

export async function POST(req: Request, { params }: Ctx) {
  return respond(req, (await params).id, true);
}
