import { describe, expect, it } from "vitest";
import { POST as create } from "@/app/api/features/route";
import { POST as pieces } from "@/app/api/features/[id]/pieces/route";
import { getFeature, updateFeature } from "@/lib/store";
import { applyPieceAction, parsePieceAction } from "./piece-admin";
import { makePiece } from "./pieces";
import type { Feature, FeatureView, Piece, Story } from "./types";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(body) });
const story = (id: string): Story => ({ id, role: "u", want: id, soThat: "", priority: "must", acceptance: [] }) as unknown as Story;

describe("piece admin", () => {
  it("parses and rejects bad actions", () => {
    expect(parsePieceAction({ action: "add", title: "  send   invite " })).toEqual({ action: "add", title: "send invite", why: undefined });
    expect(() => parsePieceAction({ action: "add", title: " " })).toThrow();
    expect(() => parsePieceAction({ action: "nope" })).toThrow();
    expect(() => parsePieceAction({ action: "remove", pieceId: "../x" })).toThrow();
  });

  it("add / rename / reorder / remove / restore / move_story", () => {
    const a = makePiece({ title: "one", order: 1 });
    const b = makePiece({ title: "two", order: 2 });
    a.stories = [story("s1"), story("s2")];
    a.runs = [{ id: "r1", storyId: "s1" } as Piece["runs"][number]];
    const f = { id: "ft_x", pieces: [a, b] } as Feature;

    const added = applyPieceAction(f, { action: "add", title: "three" });
    expect(f.pieces.map((p) => [p.title, p.order])).toEqual([["one", 1], ["two", 2], ["three", 3]]);
    expect(added.pieceId).toBe(f.pieces[2].id);

    applyPieceAction(f, { action: "rename", pieceId: b.id, title: "deux" });
    expect(f.pieces[1].title).toBe("deux");

    applyPieceAction(f, { action: "reorder", ids: [f.pieces[2].id, a.id] });
    expect(f.pieces.map((p) => p.title)).toEqual(["three", "one", "deux"]);
    expect(f.pieces.map((p) => p.order)).toEqual([1, 2, 3]);

    applyPieceAction(f, { action: "move_story", storyId: "s1", toPieceId: b.id });
    const pa = f.pieces.find((p) => p.id === a.id)!;
    const pb = f.pieces.find((p) => p.id === b.id)!;
    expect(pa.stories.map((s) => s.id)).toEqual(["s2"]);
    expect(pb.stories.map((s) => s.id)).toEqual(["s1"]);
    expect(pb.runs.map((r) => r.id)).toEqual(["r1"]);
    expect(pa.runs).toEqual([]);

    const gone = applyPieceAction(f, { action: "remove", pieceId: a.id });
    expect(f.pieces.map((p) => p.title)).toEqual(["three", "deux"]);
    expect(gone.removed?.index).toBe(1);
    applyPieceAction(f, { action: "restore", piece: gone.removed!.piece, index: gone.removed!.index });
    expect(f.pieces.map((p) => [p.title, p.order])).toEqual([["three", 1], ["one", 2], ["deux", 3]]);

    applyPieceAction(f, { action: "remove", pieceId: f.pieces[0].id });
    applyPieceAction(f, { action: "remove", pieceId: f.pieces[0].id });
    expect(() => applyPieceAction(f, { action: "remove", pieceId: f.pieces[0].id })).toThrow(/at least one/);
  });

  it("won't remove a piece that is still generating", () => {
    const a = makePiece({ title: "one", order: 1 });
    const b = makePiece({ title: "two", order: 2 });
    b.jobs = [{ kind: "stories", status: "running" } as NonNullable<Piece["jobs"]>[number]];
    const f = { id: "ft_y", pieces: [a, b] } as Feature;
    expect(() => applyPieceAction(f, { action: "remove", pieceId: b.id })).toThrow(/still generating/);
    expect(f.pieces).toHaveLength(2);
  });

  it("route returns the right view", async () => {
    const f = (await (await create(post({ title: "invites" }))).json()) as Feature;
    const [a, b] = [makePiece({ title: "one", order: 1 }), makePiece({ title: "two", order: 2 })];
    a.stories = [story("s1")];
    await updateFeature(f.id, (x) => void ((x.pieces = [a, b]), (x.phase = "ready")));

    const add = (await (await pieces(post({ action: "add", title: "three" }), ctx(f.id))).json()) as { feature: FeatureView };
    expect(add.feature.pieceId).not.toBe(a.id);
    expect(add.feature.pieces).toHaveLength(3);

    const mv = (await (await pieces(post({ action: "move_story", storyId: "s1", toPieceId: b.id, pieceId: a.id }), ctx(f.id))).json()) as {
      feature: FeatureView;
    };
    expect(mv.feature.pieceId).toBe(a.id);
    expect(mv.feature.stories).toEqual([]);
    expect(getFeature(f.id)!.pieces.find((p) => p.id === b.id)!.stories).toHaveLength(1);

    const rm = (await (await pieces(post({ action: "remove", pieceId: b.id }), ctx(f.id))).json()) as { feature: FeatureView; removed: { piece: Piece; index: number } };
    expect(rm.removed.piece.id).toBe(b.id);
    const back = (await (await pieces(post({ action: "restore", ...rm.removed }), ctx(f.id))).json()) as { feature: FeatureView };
    expect(back.feature.pieceId).toBe(b.id);
    expect(back.feature.stories).toHaveLength(1);

    expect((await pieces(post({ action: "rename", pieceId: "pc_nope", title: "x" }), ctx(f.id))).status).toBe(422);
    expect((await pieces(post({ action: "bogus" }), ctx(f.id))).status).toBe(400);
  });
});
