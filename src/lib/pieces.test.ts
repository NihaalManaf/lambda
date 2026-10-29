import { describe, expect, it } from "vitest";
import {
  allRuns,
  allStories,
  ensurePiece,
  firstPiece,
  mergePieceView,
  migrateFeature,
  pieceIdFrom,
  pieceView,
  piecesFromBrief,
  withPiece,
} from "./pieces";
import type { Feature, FlowchartSet, Mockup, Story, VerificationRun } from "./types";

const story = (id: string, sliceId?: string): Story => ({
  id, role: "user", want: `do ${id}`, soThat: "", priority: "must", acceptance: [], status: "todo", ...(sliceId ? { sliceId } : {}),
});
const run = (id: string, storyId: string): VerificationRun => ({ id, storyId, status: "passed", startedAt: "2026-01-01", log: [], shots: [] });
const flow = (id: string): FlowchartSet => ({ id, lens: "data", title: id, charts: [], createdAt: "2026-01-01" });
const mock = (id: string): Mockup => ({ id, url: "/", title: id, shot: `${id}.png`, width: 1, height: 1, elements: [], annotations: [], createdAt: "2026-01-01" });

// a pre-pieces feature as it sits in features.json
const legacy = (extra: Record<string, unknown>): Feature =>
  ({
    id: "ft_abc", title: "team invites", brief: "invite teammates", status: "shaping", createdAt: "2026-01-01", updatedAt: "2026-01-02",
    context: [{ id: "ctx_1", kind: "note", title: "n", excerpt: "e" }],
    flowcharts: [], mockups: [], stories: [], runs: [], schema: [], queues: [],
    ...extra,
  }) as unknown as Feature;

describe("migrateFeature", () => {
  it("split feature → one piece per slice; stories by slice, runs follow stories, the rest to piece 1", () => {
    const raw = legacy({
      sizing: {
        verdict: "split", reason: "two surfaces",
        slices: [
          { id: "sl_one", title: "send invite", why: "first", storyIds: ["st_a"] },
          { id: "sl_two", title: "accept invite", why: "second", storyIds: ["st_b"] },
        ],
      },
      stories: [story("st_a", "sl_one"), story("st_b", "sl_two"), story("st_c")],
      runs: [run("run_1", "st_b"), run("run_2", "st_zzz")],
      flowcharts: [flow("fs_1")],
      mockups: [mock("mk_1")],
      schema: [{ id: "sp_1" }],
      queues: [{ id: "qp_1" }],
      needs: { schema: true, queues: false, why: "new table" },
      jobs: [
        { kind: "context", status: "done" },
        { kind: "stories", status: "done" },
      ],
    });
    const f = migrateFeature(raw);
    expect(f.phase).toBe("ready");
    expect(f.pieces.map((p) => [p.id, p.order, p.title, p.why])).toEqual([
      ["pc_one", 1, "send invite", "first"],
      ["pc_two", 2, "accept invite", "second"],
    ]);
    const [p1, p2] = f.pieces;
    expect(p1.stories.map((s) => s.id)).toEqual(["st_a", "st_c"]); // unsliced → piece 1
    expect(p2.stories.map((s) => s.id)).toEqual(["st_b"]);
    expect(p2.runs.map((r) => r.id)).toEqual(["run_1"]);
    expect(p1.runs.map((r) => r.id)).toEqual(["run_2"]);
    expect(p1.flowcharts.map((s) => s.id)).toEqual(["fs_1"]);
    expect(p1.mockups.map((m) => m.id)).toEqual(["mk_1"]);
    expect(p1.schema?.map((s) => s.id)).toEqual(["sp_1"]);
    expect(p1.queues?.map((s) => s.id)).toEqual(["qp_1"]);
    expect(p1.needs?.schema).toBe(true);
    expect(p2.flowcharts).toEqual([]);
    expect(f.jobs?.map((j) => j.kind)).toEqual(["context"]);
    expect(p1.jobs?.map((j) => j.kind)).toEqual(["stories"]);
    for (const k of ["stories", "flowcharts", "mockups", "runs", "schema", "queues", "needs", "sizing"]) expect(k in f).toBe(false);
    expect(f.context).toEqual(raw.context); // feature-level untouched
    // nothing lost
    expect(allStories(f)).toHaveLength(3);
    expect(allRuns(f)).toHaveLength(2);
  });

  it("one-piece feature → a single piece with everything", () => {
    const raw = legacy({
      sizing: { verdict: "one-piece", reason: "", slices: [{ id: "sl_x", title: "all", why: "", storyIds: ["st_a"] }] },
      stories: [story("st_a", "sl_x"), story("st_b")],
      runs: [run("run_1", "st_a")],
      flowcharts: [flow("fs_1"), flow("fs_2")],
    });
    const f = migrateFeature(raw);
    expect(f.pieces).toHaveLength(1);
    const p = f.pieces[0];
    expect(p.id).toBe("pc_abc");
    expect(p.title).toBe("team invites");
    expect(p.stories.map((s) => s.id)).toEqual(["st_a", "st_b"]);
    expect(p.runs).toHaveLength(1);
    expect(p.flowcharts).toHaveLength(2);
  });

  it("empty feature → one empty piece, phase ready", () => {
    const f = migrateFeature(legacy({ flowcharts: [], stories: [], runs: [], mockups: [] }));
    expect(f.phase).toBe("ready");
    expect(f.pieces).toHaveLength(1);
    expect(f.pieces[0]).toMatchObject({ stories: [], flowcharts: [], mockups: [], runs: [], order: 1 });
  });

  it("is idempotent and deterministic (same ids on every read)", () => {
    const raw = legacy({ stories: [story("st_a")] });
    const a = migrateFeature(raw);
    const b = migrateFeature(structuredClone(raw));
    expect(a.pieces[0].id).toBe(b.pieces[0].id);
    const again = migrateFeature(JSON.parse(JSON.stringify(a)));
    expect(again).toEqual(JSON.parse(JSON.stringify(a)));
    expect(migrateFeature(a)).toBe(a); // already migrated: untouched
  });

  it("folds stray top-level arrays (written by an old process) into piece 1 without duplicates", () => {
    const a = migrateFeature(legacy({ stories: [story("st_a")] }));
    const stray = { ...a, stories: [story("st_a"), story("st_new")] } as unknown as Feature;
    const f = migrateFeature(stray);
    expect(f.pieces[0].stories.map((s) => s.id)).toEqual(["st_a", "st_new"]);
    expect("stories" in f).toBe(false);
  });

  it("stray arrays never duplicate work another piece already holds", () => {
    const raw = legacy({
      sizing: { verdict: "split", reason: "", slices: [{ id: "sl_one", title: "one", why: "", storyIds: [] }, { id: "sl_two", title: "two", why: "", storyIds: [] }] },
      stories: [story("st_a", "sl_one"), story("st_b", "sl_two")],
      runs: [run("run_b", "st_b")],
      flowcharts: [flow("fs_1")],
    });
    const m = migrateFeature(raw);
    m.pieces[1].flowcharts = [flow("fs_2")];
    // an old process rewrote stale copies of everything at the top level
    const stray = { ...m, stories: [story("st_a"), story("st_b")], runs: [run("run_b", "st_b")], flowcharts: [flow("fs_1"), flow("fs_2")] } as unknown as Feature;
    const f = migrateFeature(stray);
    expect(f.pieces.map((p) => p.stories.map((s) => s.id))).toEqual([["st_a"], ["st_b"]]);
    expect(f.pieces.map((p) => p.runs.map((r) => r.id))).toEqual([[], ["run_b"]]);
    expect(f.pieces.map((p) => p.flowcharts.map((x) => x.id))).toEqual([["fs_1"], ["fs_2"]]);
  });

  it("new intake features (no pieces) stay as they are", () => {
    const f: Feature = { id: "ft_n", title: "t", brief: "", phase: "intake", status: "shaping", createdAt: "", updatedAt: "", context: [], pieces: [] };
    expect(migrateFeature(f)).toBe(f);
  });
});

describe("pieceView / mergePieceView", () => {
  const two = () =>
    migrateFeature(
      legacy({
        sizing: {
          verdict: "split", reason: "",
          slices: [
            { id: "sl_one", title: "one", why: "", storyIds: [] },
            { id: "sl_two", title: "two", why: "", storyIds: [] },
          ],
        },
        stories: [story("st_a", "sl_one"), story("st_b", "sl_two")],
        jobs: [{ kind: "context", status: "done" }],
      }),
    );

  it("projects the piece onto a Feature-shaped object (first piece by default)", () => {
    const f = two();
    f.pieces[1].jobs = [{ kind: "stories", status: "running" }];
    const v1 = pieceView(f);
    expect(v1.pieceId).toBe("pc_one");
    expect(v1.stories.map((s) => s.id)).toEqual(["st_a"]);
    expect(v1.sizing).toBeUndefined();
    const v2 = pieceView(f, "pc_two");
    expect(v2.stories.map((s) => s.id)).toEqual(["st_b"]);
    expect(v2.jobs?.map((j) => j.kind)).toEqual(["context", "stories"]);
    expect(v2.context).toBe(f.context);
    expect(pieceView(f, "pc_nope").pieceId).toBe("pc_one"); // unknown → first
  });

  it("merges a view's edits back into its piece only", () => {
    const f = two();
    const v = pieceView(f, "pc_two");
    const edited = { ...v, title: "renamed", stories: [...v.stories, story("st_c")], jobs: [...(v.jobs ?? []), { kind: "flows" as const, status: "queued" as const }] };
    const next = mergePieceView(f, "pc_two", edited);
    expect(next.title).toBe("renamed");
    expect(next.pieces[1].stories.map((s) => s.id)).toEqual(["st_b", "st_c"]);
    expect(next.pieces[0].stories.map((s) => s.id)).toEqual(["st_a"]);
    expect(next.jobs?.map((j) => j.kind)).toEqual(["context"]);
    expect(next.pieces[1].jobs?.map((j) => j.kind)).toEqual(["flows"]);
    for (const k of ["stories", "flowcharts", "pieceId", "sizing"]) expect(k in next).toBe(false);
    expect(f.pieces[1].stories).toHaveLength(1); // pure
  });

  it("round-trips: merge(view(f)) equals f", () => {
    const f = two();
    expect(mergePieceView(f, "pc_two", pieceView(f, "pc_two"))).toEqual(f);
  });

  it("a plain stored feature replaces the current one", () => {
    const f = two();
    const fresh = { ...two(), title: "server" };
    expect(mergePieceView(f, "pc_one", fresh).title).toBe("server");
  });

  it("feature with no pieces: empty view, merge is a no-op on pieces", () => {
    const f: Feature = { id: "ft_n", title: "t", brief: "", phase: "intake", status: "shaping", createdAt: "", updatedAt: "", context: [], pieces: [] };
    const v = pieceView(f);
    expect(v.pieceId).toBe("");
    expect(v.stories).toEqual([]);
    expect(mergePieceView(f, "", { ...v, title: "x" })).toMatchObject({ title: "x", pieces: [] });
  });
});

describe("withPiece / ensurePiece", () => {
  it("writes view edits back in place (sync + async)", async () => {
    const f = migrateFeature(legacy({ stories: [story("st_a")] }));
    const n = withPiece(f, undefined, (v) => {
      v.stories.push(story("st_b"));
      v.context = [];
      return v.stories.length;
    });
    expect(n).toBe(2);
    expect(f.pieces[0].stories).toHaveLength(2);
    expect(f.context).toEqual([]);
    expect("stories" in f).toBe(false);
    await withPiece(f, f.pieces[0].id, async (v) => {
      await Promise.resolve();
      v.flowcharts = [flow("fs_9")];
    });
    expect(f.pieces[0].flowcharts.map((s) => s.id)).toEqual(["fs_9"]);
    expect(() => withPiece(f, "pc_nope", () => 1)).toThrow(/not found/);
  });

  it("creates the first piece when there is none", () => {
    const f: Feature = { id: "ft_n", title: "invites", brief: "", phase: "intake", status: "shaping", createdAt: "", updatedAt: "", context: [], pieces: [] };
    withPiece(f, undefined, (v) => void v.stories.push(story("st_a")));
    expect(f.pieces).toHaveLength(1);
    expect(f.pieces[0].title).toBe("invites");
    expect(f.pieces[0].stories).toHaveLength(1);
    expect(ensurePiece(f)).toBe(f.pieces[0]);
    expect(firstPiece(f)).toBe(f.pieces[0]);
  });
});

describe("piecesFromBrief / pieceIdFrom", () => {
  it("orders pieces and caps at 5", () => {
    const ps = piecesFromBrief({ pieces: Array.from({ length: 7 }, (_, i) => ({ title: `p${i}`, why: "w", scope: ["s"] })) });
    expect(ps.map((p) => p.order)).toEqual([1, 2, 3, 4, 5]);
    expect(ps[0]).toMatchObject({ title: "p0", scope: ["s"], stories: [], status: "shaping" });
    expect(new Set(ps.map((p) => p.id)).size).toBe(5);
    expect(piecesFromBrief({ pieces: [] })).toHaveLength(1);
  });

  it("reads ?piece= first, then body.pieceId; rejects junk", () => {
    expect(pieceIdFrom("http://x/a?piece=pc_1", { pieceId: "pc_2" })).toBe("pc_1");
    expect(pieceIdFrom("http://x/a", { pieceId: "pc_2" })).toBe("pc_2");
    expect(pieceIdFrom("http://x/a", { pieceId: "../../x" })).toBeUndefined();
    expect(pieceIdFrom("http://x/a")).toBeUndefined();
  });
});
