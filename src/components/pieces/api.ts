import type { PieceAction } from "@/lib/piece-admin";
import type { FeatureView, Piece } from "@/lib/types";

// Piece management (rail + story moves). Every call returns a view: of the piece the action points at,
// or of `pieceId` (the one on screen) for rename / reorder / move_story.
export async function pieceAction(fid: string, a: PieceAction, pieceId?: string) {
  const res = await fetch(`/api/features/${fid}/pieces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...a, pieceId: pieceId || undefined }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body as { feature: FeatureView; removed?: { piece: Piece; index: number } };
}

// stories board ⇄ piece rail: a dragged story tile hovering / dropped over a rail card
export const PIECE_HOVER = "lambda:piece-hover";
export const pieceAt = (x: number, y: number): string | null => {
  for (const el of document.elementsFromPoint(x, y)) {
    const c = (el as HTMLElement).closest?.("[data-piece-drop]");
    if (c) return c.getAttribute("data-piece-drop");
  }
  return null;
};
export const hoverPiece = (id: string | null) => window.dispatchEvent(new CustomEvent<string | null>(PIECE_HOVER, { detail: id }));
