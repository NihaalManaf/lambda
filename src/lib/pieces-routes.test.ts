import { describe, expect, it } from "vitest";
import { POST as create } from "@/app/api/features/route";
import { GET as getOne } from "@/app/api/features/[id]/route";
import { POST as ops } from "@/app/api/features/[id]/ops/route";
import { DELETE as delStory } from "@/app/api/features/[id]/stories/route";
import { getFeature, updateFeature } from "@/lib/store";
import { makePiece } from "./pieces";
import type { Feature, FeatureView } from "./types";

// Route-level wiring on pieces (no model calls). LAMBDA_DATA_DIR is a temp dir (vitest.config.ts).
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (url: string, body: unknown) => new Request(url, { method: "POST", body: JSON.stringify(body) });

describe("feature routes on pieces", () => {
  it("POST /api/features → phase intake, no pieces, no jobs", async () => {
    const f = (await (await create(post("http://x", { title: "team invites" }))).json()) as Feature;
    expect(f.phase).toBe("intake");
    expect(f.pieces).toEqual([]);
    expect(f.jobs ?? []).toEqual([]);
  });

  it("ops edit the requested piece and return its view", async () => {
    const f = (await (await create(post("http://x", { title: "caps" }))).json()) as Feature;
    const [a, b] = [makePiece({ title: "one", order: 1 }), makePiece({ title: "two", order: 2 })];
    await updateFeature(f.id, (x) => void (x.pieces = [a, b]));
    const add = { op: "add_story", role: "admin", want: "see usage", soThat: "plan" };

    const r1 = (await (await ops(post("http://x", { ops: [add], pieceId: b.id }), ctx(f.id))).json()) as { feature: FeatureView; notes: { piece?: string }[] };
    expect(r1.feature.pieceId).toBe(b.id);
    expect(r1.feature.stories).toHaveLength(1);
    expect(r1.notes[0].piece).toBe(b.id);
    const r2 = (await (await ops(post("http://x", { ops: [add] }), ctx(f.id))).json()) as { feature: FeatureView };
    expect(r2.feature.pieceId).toBe(a.id); // default: first piece

    const stored = getFeature(f.id)!;
    expect(stored.pieces.map((p) => p.stories.length)).toEqual([1, 1]);
    expect("stories" in stored).toBe(false);

    const v = (await (await getOne(new Request(`http://x?piece=${b.id}`), ctx(f.id))).json()) as FeatureView;
    expect(v.pieceId).toBe(b.id);
    expect(v.pieces).toHaveLength(2);

    const sid = stored.pieces[1].stories[0].id;
    const after = (await (await delStory(new Request(`http://x?storyId=${sid}`, { method: "DELETE" }), ctx(f.id))).json()) as FeatureView;
    expect(after.pieceId).toBe(b.id);
    expect(after.stories).toEqual([]);

    const bad = await ops(post("http://x", { ops: [add], pieceId: "pc_nope" }), ctx(f.id));
    expect(bad.status).toBe(422);
  });

  it("ops on a feature without pieces create the first piece", async () => {
    const f = (await (await create(post("http://x", { title: "solo" }))).json()) as Feature;
    const r = await ops(post("http://x", { ops: [{ op: "add_story", role: "u", want: "do it", soThat: "" }] }), ctx(f.id));
    expect(r.status).toBe(200);
    expect(getFeature(f.id)!.pieces).toHaveLength(1);
  });
});
