import { describe, expect, it, vi } from "vitest";

// own store: test files run in parallel and must not share features.json (set before store.ts loads)
vi.hoisted(() => {
  process.env.LAMBDA_DATA_DIR = `${process.env.LAMBDA_DATA_DIR ?? "/tmp/lambda-vitest"}-chat-pieces`;
});

// chat.ts imports the intake session (spawns claude); piece ops never touch it
vi.mock("./intake", () => ({ askCodebase: vi.fn(async () => "stub") }));

import { POST as create } from "@/app/api/features/route";
import { POST as ops } from "@/app/api/features/[id]/ops/route";
import { getFeature, updateFeature } from "@/lib/store";
import { applyOps, clearThread, fingerprint, isKnownOp, snapshot, undoTurn } from "./chat";
import { makePiece, pieceView } from "./pieces";
import type { Feature, FeatureView } from "./types";

// Piece ops (add / rename / move_story / remove / reorder) through the shared dispatcher. No model calls:
// add_piece runs with generate=false.
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (url: string, body: unknown) => new Request(url, { method: "POST", body: JSON.stringify(body) });

async function twoPieces(title: string) {
  const f = (await (await create(post("http://x", { title }))).json()) as Feature;
  const [a, b] = [makePiece({ title: "send invite", order: 1 }), makePiece({ title: "accept invite", order: 2 })];
  await updateFeature(f.id, (x) => {
    x.phase = "ready";
    x.pieces = [a, b];
  });
  await applyOps(f.id, [{ op: "add_story", role: "admin", want: "send an invite", soThat: "team grows" }], undefined, a.id);
  await applyOps(f.id, [{ op: "add_story", role: "admin", want: "resend an invite", soThat: "it arrives" }], undefined, a.id);
  return { fid: f.id, a: a.id, b: b.id };
}

describe("piece ops", () => {
  it("are known ops (the ops route accepts them)", () => {
    for (const op of ["add_piece", "rename_piece", "move_story", "remove_piece", "reorder_pieces"]) expect(isKnownOp({ op })).toBe(true);
    expect(isKnownOp({ op: "ask_codebase" })).toBe(false);
  });

  it("add, rename, move a story, reorder, remove", async () => {
    const { fid, a, b } = await twoPieces("invites");

    const add = (await (await ops(post("http://x", { ops: [{ op: "add_piece", title: "resend and revoke", why: "admin cleanup", generate: false }] }), ctx(fid))).json()) as {
      feature: FeatureView;
      notes: { what: string; piece?: string }[];
    };
    expect(add.notes[0].what).toBe("piece");
    const c = add.notes[0].piece!;
    expect(add.feature.pieces.map((p) => [p.order, p.title])).toEqual([[1, "send invite"], [2, "accept invite"], [3, "resend and revoke"]]);
    expect(add.feature.pieces.find((p) => p.id === c)!.jobs ?? []).toEqual([]); // generate=false: no jobs

    await applyOps(fid, [{ op: "rename_piece", pieceId: c, title: "resend + revoke" }]);
    const resend = getFeature(fid)!.pieces.find((p) => p.id === a)!.stories.find((s) => s.want.startsWith("resend"))!;
    const moved = await applyOps(fid, [{ op: "move_story", storyId: resend.id, toPieceId: c }], undefined, a);
    expect(moved.feature.pieceId).toBe(a);
    expect(moved.feature.stories.map((s) => s.want)).toEqual(["send an invite"]); // the selected view lost it
    expect(moved.notes[0]).toMatchObject({ what: "story", ref: resend.id, piece: c });
    let stored = getFeature(fid)!;
    expect(stored.pieces.find((p) => p.id === c)!.stories.map((s) => s.id)).toEqual([resend.id]);
    expect(stored.pieces.find((p) => p.id === c)!.title).toBe("resend + revoke");

    await applyOps(fid, [{ op: "reorder_pieces", order: [c, a] }]);
    stored = getFeature(fid)!;
    expect([...stored.pieces].sort((x, y) => x.order - y.order).map((p) => p.id)).toEqual([c, a, b]);

    // remove the selected piece, keeping its stories: edits fall back to the first piece
    const rm = await applyOps(fid, [{ op: "remove_piece", pieceId: c, moveStoriesTo: b }], undefined, c);
    expect(rm.feature.pieceId).toBe(a);
    stored = getFeature(fid)!;
    expect(stored.pieces.map((p) => [p.id, p.order])).toEqual([[a, 1], [b, 2]]);
    expect(stored.pieces.find((p) => p.id === b)!.stories.map((s) => s.id)).toEqual([resend.id]);
  });

  it("a story's runs travel with it (move_story and remove_piece + moveStoriesTo)", async () => {
    const { fid, a, b } = await twoPieces("runs travel");
    const [s1, s2] = getFeature(fid)!.pieces.find((p) => p.id === a)!.stories;
    await updateFeature(fid, (x) => {
      x.pieces.find((p) => p.id === a)!.runs = [
        { id: "r1", storyId: s1.id } as Feature["pieces"][number]["runs"][number],
        { id: "r2", storyId: s2.id } as Feature["pieces"][number]["runs"][number],
      ];
    });
    await applyOps(fid, [{ op: "move_story", storyId: s1.id, toPieceId: b }]);
    let st = getFeature(fid)!;
    expect(st.pieces.find((p) => p.id === b)!.runs.map((r) => r.id)).toEqual(["r1"]);
    expect(st.pieces.find((p) => p.id === a)!.runs.map((r) => r.id)).toEqual(["r2"]);
    await applyOps(fid, [{ op: "remove_piece", pieceId: a, moveStoriesTo: b }]);
    st = getFeature(fid)!;
    expect(st.pieces.map((p) => p.id)).toEqual([b]);
    expect(st.pieces[0].runs.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
  });

  it("clearing the thread keeps the intake conversation", async () => {
    const { fid } = await twoPieces("clear keeps intake");
    await updateFeature(fid, (x) => {
      x.chat = [
        { id: "c1", at: "", role: "user", text: "who sends?", source: "intake" },
        { id: "c2", at: "", role: "user", text: "add a story", source: "edit" },
        { id: "c3", at: "", role: "assistant", text: "it lives in x", source: "code" },
      ];
    });
    expect((await clearThread(fid)).chat?.map((m) => m.id)).toEqual(["c1"]);
  });

  it("refuses to remove the last piece, unknown ids, and edits atomically", async () => {
    const { fid, a, b } = await twoPieces("caps");
    await expect(applyOps(fid, [{ op: "remove_piece", pieceId: "pc_nope" }])).rejects.toThrow(/not found/);
    await applyOps(fid, [{ op: "remove_piece", pieceId: b }]);
    await expect(applyOps(fid, [{ op: "remove_piece", pieceId: a }])).rejects.toThrow(/at least one/);
    const before = JSON.stringify(getFeature(fid)!.pieces);
    // second op fails → the rename is not written either
    await expect(applyOps(fid, [{ op: "rename_piece", pieceId: a, title: "renamed" }, { op: "move_story", storyId: "st_nope", toPieceId: a }])).rejects.toThrow();
    expect(JSON.stringify(getFeature(fid)!.pieces)).toBe(before);
  });

  it("snapshot lists every piece with ids and other pieces' stories", async () => {
    const { fid, a, b } = await twoPieces("snap");
    const s = snapshot(pieceView(getFeature(fid)!, b));
    expect(s).toContain(`▸ 2. ${b} "accept invite"`);
    expect(s).toContain(`  1. ${a} "send invite"`);
    expect(s).toContain("send an invite"); // story of the other piece, by id, so move_story can name it
    expect(s).toContain("stories of the selected piece (0)");
  });

  it("undo restores pieces as they were before a chat turn", async () => {
    const { fid, a, b } = await twoPieces("undo");
    const f = getFeature(fid)!;
    const before = structuredClone({ title: f.title, brief: f.brief, context: f.context, contextDismissed: f.contextDismissed, pieces: f.pieces });
    await applyOps(fid, [{ op: "remove_piece", pieceId: b }]);
    // the turn record runChat writes after its ops
    await updateFeature(fid, (x) => {
      x.chat = [{ id: "ct_t", role: "assistant", text: "", at: "", source: "edit", notes: [] }];
      x.chatUndo = { turnId: "ct_t", before, after: fingerprint(x) };
    });
    await undoTurn(fid);
    const back = getFeature(fid)!;
    expect(back.pieces.map((p) => [p.id, p.order])).toEqual([[a, 1], [b, 2]]);
    expect(back.chat?.[0].undone).toBe(true);
  });
});
