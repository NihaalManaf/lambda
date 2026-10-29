import { NextResponse } from "next/server";
import { applyPieceAction, parsePieceAction, type PieceAction } from "@/lib/piece-admin";
import { pieceIdFrom, pieceView } from "@/lib/pieces";
import { getFeature, updateFeature } from "@/lib/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// POST {action: add|rename|reorder|remove|restore|move_story, …, pieceId?} → {feature: pieceView, removed?}
// The view is of the piece the action points at (new / renamed / restored piece, the story's old piece,
// the neighbour of a removed one), else ?piece= / body.pieceId, else the first piece.
export async function POST(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  if (!getFeature(fid)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await req.json().catch(() => null);
  let action: PieceAction;
  try {
    action = parsePieceAction(body);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    let out: ReturnType<typeof applyPieceAction> = {};
    const f = await updateFeature(fid, (f) => void (out = applyPieceAction(f, action)));
    const asked = action.action === "remove" ? undefined : pieceIdFrom(req.url, body);
    const pid = action.action === "add" || action.action === "restore" || action.action === "remove" ? out.pieceId : asked ?? out.pieceId;
    const view = pieceView(f, f.pieces.some((p) => p.id === pid) ? pid : undefined);
    return NextResponse.json({ feature: view, ...(out.removed ? { removed: out.removed } : {}) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 422 });
  }
}
