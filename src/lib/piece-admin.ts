import { makePiece, moveStories, pieceBusy, sortPieces } from "./pieces";
import type { Feature, Piece } from "./types";

// Piece management on a stored Feature, in place (call inside updateFeature). Pure apart from mutating f.
// Used by POST /api/features/[id]/pieces (the workspace rail); chat tools may reuse it.

export type PieceAction =
  | { action: "add"; title: string; why?: string }
  | { action: "rename"; pieceId: string; title: string }
  | { action: "reorder"; ids: string[] }
  | { action: "remove"; pieceId: string }
  | { action: "restore"; piece: Piece; index?: number }
  | { action: "move_story"; storyId: string; toPieceId: string };

const clean = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");
const isId = (s: unknown): s is string => typeof s === "string" && /^[\w-]{1,64}$/.test(s);
const renumber = (ps: Piece[]) => ps.map((p, i) => (p.order === i + 1 ? p : { ...p, order: i + 1 }));
const need = (f: Feature, id: string) => {
  const p = f.pieces.find((x) => x.id === id);
  if (!p) throw new Error("piece not found");
  return p;
};

// Validates the untrusted body shape; throws with a short message.
export function parsePieceAction(b: unknown): PieceAction {
  const o = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
  switch (o.action) {
    case "add": {
      const title = clean(o.title, 60);
      if (!title) throw new Error("title required");
      return { action: "add", title, why: clean(o.why, 140) || undefined };
    }
    case "rename": {
      const title = clean(o.title, 60);
      if (!isId(o.pieceId) || !title) throw new Error("pieceId + title required");
      return { action: "rename", pieceId: o.pieceId, title };
    }
    case "reorder":
      if (!Array.isArray(o.ids) || !o.ids.every(isId)) throw new Error("ids required");
      return { action: "reorder", ids: o.ids as string[] };
    case "remove":
      if (!isId(o.pieceId)) throw new Error("pieceId required");
      return { action: "remove", pieceId: o.pieceId };
    case "restore": {
      const p = o.piece as Piece | undefined;
      if (!p || !isId(p.id) || typeof p.title !== "string" || !Array.isArray(p.stories) || !Array.isArray(p.flowcharts))
        throw new Error("piece required");
      return { action: "restore", piece: p, index: typeof o.index === "number" ? o.index : undefined };
    }
    case "move_story":
      if (!isId(o.storyId) || !isId(o.toPieceId)) throw new Error("storyId + toPieceId required");
      return { action: "move_story", storyId: o.storyId, toPieceId: o.toPieceId };
    default:
      throw new Error("unknown action");
  }
}

// Applies one action. Returns the piece the client should look at next (+ the removed piece for undo).
export function applyPieceAction(f: Feature, a: PieceAction): { pieceId?: string; removed?: { piece: Piece; index: number } } {
  const ordered = sortPieces(f.pieces);
  switch (a.action) {
    case "add": {
      const p = makePiece({ title: a.title, why: a.why, order: ordered.length + 1, status: "shaping" });
      f.pieces = [...ordered, p];
      return { pieceId: p.id };
    }
    case "rename":
      need(f, a.pieceId).title = a.title;
      return { pieceId: a.pieceId };
    case "reorder": {
      const rank = new Map(a.ids.map((id, i) => [id, i]));
      // ids not named keep their relative order after the named ones
      const next = [...ordered].sort((x, y) => (rank.get(x.id) ?? 1e6 + x.order) - (rank.get(y.id) ?? 1e6 + y.order));
      f.pieces = renumber(next);
      return {};
    }
    case "remove": {
      if (f.pieces.length <= 1) throw new Error("a feature keeps at least one piece");
      const index = ordered.findIndex((p) => p.id === a.pieceId);
      if (index < 0) throw new Error("piece not found");
      // its jobs would keep spending tokens, then fail to commit into a piece that's gone
      if (pieceBusy(ordered[index])) throw new Error("that piece is still generating — try again in a moment");
      const [piece] = ordered.splice(index, 1);
      f.pieces = renumber(ordered);
      return { pieceId: ordered[Math.max(0, index - 1)]?.id, removed: { piece, index } };
    }
    case "restore": {
      if (f.pieces.some((p) => p.id === a.piece.id)) return { pieceId: a.piece.id };
      // jobs that were live when it was removed can't finish any more
      const jobs = (a.piece.jobs ?? []).map((j) =>
        j.status === "queued" || j.status === "running" ? { ...j, status: "error" as const, error: "stopped (piece was removed)" } : j,
      );
      const piece: Piece = { ...a.piece, mockups: a.piece.mockups ?? [], runs: a.piece.runs ?? [], ...(jobs.length ? { jobs } : {}) };
      const at = Math.max(0, Math.min(a.index ?? ordered.length, ordered.length));
      ordered.splice(at, 0, piece);
      f.pieces = renumber(ordered);
      return { pieceId: piece.id };
    }
    case "move_story": {
      const to = need(f, a.toPieceId);
      const from = f.pieces.find((p) => p.stories.some((s) => s.id === a.storyId));
      if (!from) throw new Error("story not found");
      if (from.id === to.id) return { pieceId: from.id };
      if (pieceBusy(from, ["stories"]) || pieceBusy(to, ["stories"])) throw new Error("stories still generating — try again in a moment");
      moveStories(from, to, [a.storyId]); // its browser runs travel with it
      return { pieceId: from.id };
    }
  }
}
