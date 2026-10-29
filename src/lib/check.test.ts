import { describe, expect, it } from "vitest";
import { planCheck, planRoutes } from "./check";
import type { CheckItem } from "./facts";
import { applyCheckPlan, checkNote } from "./grounding";
import { makePiece, pieceView } from "./pieces";
import { applyStoryOpWith } from "./stories-apply";
import type { Feature, FeatureMode, Story } from "./types";

const ROUTES = ["/", "/media-database", "/media-database/[mediaId]", "/settings/billing"];

function feature(mode: FeatureMode = "build"): Feature {
  const p = makePiece({ id: "pc_1", title: "media list", order: 1 });
  const story = (id: string, startPath: string, extra: Partial<Story["acceptance"][number]> = {}): Story => ({
    id,
    role: "host",
    want: "browse media",
    soThat: "pick guests",
    priority: "must",
    status: "todo",
    acceptance: [{ id: `ac_${id}`, given: "signed in", when: "open list", then: "rows show", startPath, steps: ["click 'new campaign'"], ...extra }],
  });
  p.stories = [story("s1", "/campaigns"), story("s2", "/media-database/42"), story("s3", "/billing/settings"), story("s4", "/media-database", { unverified: "route /x isn't in the app's routes" })];
  p.flowcharts = [
    {
      id: "fs_1",
      lens: "customer-journey",
      title: "browse",
      createdAt: "",
      charts: [
        {
          id: "fc_1",
          title: "list",
          summary: "",
          nodes: [{ id: "n1", label: "open campaigns", kind: "start" }, { id: "n2", label: "pick row", kind: "step" }],
          edges: [],
          edgeCases: [{ id: "ec_1", nodeId: "n2", text: "empty list", handled: null }],
        },
      ],
    },
  ];
  return { id: "f1", title: "media", brief: "", phase: "ready", status: "shaping", createdAt: "", updatedAt: "", context: [], pieces: [p], ...(mode === "understand" ? { mode } : {}) };
}

const verdict = (target: CheckItem["target"], v: CheckItem["verdict"], fix?: CheckItem["fix"], why = "x"): CheckItem => ({ target, verdict: v, fix, evidence: "a.tsx:1", why });

describe("check: routes", () => {
  it("ok / snapped / unverified, and clears a stale route mark", () => {
    const v = pieceView(feature(), "pc_1");
    const plan = planRoutes(v, ROUTES);
    expect(plan.counts).toMatchObject({ ok: 2, fixed: 1, flagged: 1 });
    const c = applyCheckPlan(v, plan);
    const ac = (sid: string) => v.stories.find((s) => s.id === sid)!.acceptance[0];
    expect(ac("s1").unverified).toBe("route /campaigns isn't in the app's routes");
    expect(ac("s3").startPath).toBe("/settings/billing");
    expect(ac("s2").unverified).toBeUndefined();
    expect(ac("s4").unverified).toBeUndefined(); // its route is real now
    expect(c).toMatchObject({ ok: 2, fixed: 1, flagged: 1 });
    expect(v.pieces[0].check?.fixed).toBe(1);
    expect(checkNote(c)).toBe("2 ok · 1 fixed · 1 flagged");
  });

  it("a param-only hit or an unfilled [param] isn't ok: marked unverified", () => {
    const v = pieceView(feature(), "pc_1");
    v.stories[1].acceptance[0].startPath = "/media-database/[id]";
    const plan = planRoutes(v, ["/[team]", "/media-database/[mediaId]"]);
    applyCheckPlan(v, plan);
    expect(v.stories[0].acceptance[0].unverified).toBe("route /campaigns only matches /[team]");
    expect(v.stories[1].acceptance[0].unverified).toBe("route /media-database/[id] has an unfilled [param]");
  });

  it("no routes known → nothing to say", () => {
    expect(planRoutes(pieceView(feature(), "pc_1"), []).ops).toEqual([]);
  });
});

describe("check: verifier verdicts", () => {
  it("plain fixes go through the story / flow ops; the verifier's route beats the snap", () => {
    const v = pieceView(feature(), "pc_1");
    const items = [
      verdict({ kind: "criterion", id: "ac_s1" }, "wrong", { field: "startPath", value: "/media-database" }), // storyId looked up
      verdict({ kind: "criterion", id: "ac_s2", storyId: "s2" }, "wrong", { field: "steps", value: ["click 'Add media'", "expect text 'Saved'"] }),
      verdict({ kind: "node", id: "n1" }, "wrong", { field: "label", value: "open media database" }), // set/chart resolved
      verdict({ kind: "edgeCase", id: "ec_1", setId: "fs_1", chartId: "fc_1" }, "wrong", { field: "text", value: "empty list shows 'No media yet'" }),
      verdict({ kind: "story", id: "s3" }, "ok"),
      verdict({ kind: "story", id: "st_gone" }, "wrong", { field: "want", value: "x" }), // unknown id: dropped
      verdict({ kind: "node", id: "n2" }, "unsure"),
    ];
    const plan = planCheck(v, items, ROUTES, "build", "pc_1");
    const c = applyCheckPlan(v, plan);
    const s1 = v.stories.find((s) => s.id === "s1")!.acceptance[0];
    expect(s1.startPath).toBe("/media-database");
    expect(s1.unverified).toBeUndefined();
    expect(v.stories.find((s) => s.id === "s2")!.acceptance[0].steps).toEqual(["click 'Add media'", "expect text 'Saved'"]);
    const chart = v.flowcharts[0].charts[0];
    expect(chart.nodes[0].label).toBe("open media database");
    expect(chart.edgeCases[0]).toMatchObject({ id: "ec_1", text: "empty list shows 'No media yet'", handled: null });
    expect(c.fixed).toBe(5); // 4 verdicts + the /billing snap
    expect(c.unsure).toBe(1);
  });

  it("a route fix off the route list isn't plain: build marks the criterion, understand logs an issue", () => {
    const bad = verdict({ kind: "criterion", id: "ac_s2", storyId: "s2" }, "wrong", { field: "startPath", value: "/nowhere" }, "list lives elsewhere");
    const node = verdict({ kind: "node", id: "n2", setId: "fs_1", chartId: "fc_1" }, "wrong", { field: "description", value: "?" }, "rows aren't clickable");

    const b = pieceView(feature("build"), "pc_1");
    const cb = applyCheckPlan(b, planCheck(b, [bad, node], ROUTES, "build", "pc_1"));
    expect(b.stories.find((s) => s.id === "s2")!.acceptance[0].unverified).toBe("list lives elsewhere (a.tsx:1)");
    expect(cb.flags).toEqual([{ kind: "node", id: "n2", why: "rows aren't clickable", evidence: "a.tsx:1" }]);
    expect(b.issues ?? []).toEqual([]);

    const u = pieceView(feature("understand"), "pc_1");
    applyCheckPlan(u, planCheck(u, [bad, node], ROUTES, "understand", "pc_1"));
    expect(u.stories.find((s) => s.id === "s2")!.acceptance[0].unverified).toBeUndefined();
    expect(u.issues?.map((i) => [i.source, i.ref?.tab, i.ref?.id, i.pieceId])).toEqual([
      ["check", "stories", "s2", "pc_1"],
      ["check", "flows", "n2", "pc_1"],
    ]);
  });

  it("a steps fix keeps the route mark; a verifier mark rides on a snap; a route fix must be concrete", () => {
    const v = pieceView(feature(), "pc_1");
    const items = [
      verdict({ kind: "criterion", id: "ac_s1", storyId: "s1" }, "wrong", { field: "steps", value: ["click 'Add media'"] }), // /campaigns: unknown
      verdict({ kind: "criterion", id: "ac_s3", storyId: "s3" }, "wrong", undefined, "no billing tab"), // /billing/settings: snapped
      verdict({ kind: "criterion", id: "ac_s2", storyId: "s2" }, "wrong", { field: "startPath", value: "/media-database/[mediaId]" }),
    ];
    const c = applyCheckPlan(v, planCheck(v, items, ROUTES, "build"));
    const ac = (sid: string) => v.stories.find((s) => s.id === sid)!.acceptance[0];
    expect(ac("s1").steps).toEqual(["click 'Add media'"]);
    expect(ac("s1").unverified).toBe("route /campaigns isn't in the app's routes");
    expect(ac("s3")).toMatchObject({ startPath: "/settings/billing", unverified: "no billing tab (a.tsx:1)" });
    expect(ac("s2")).toMatchObject({ startPath: "/media-database/42", unverified: "x (a.tsx:1)" }); // the [param] fix isn't plain
    expect(c).toMatchObject({ fixed: 2, flagged: 3 });
  });

  it("a node label fix keeps its description", () => {
    const v = pieceView(feature(), "pc_1");
    v.flowcharts[0].charts[0].nodes[0].description = "a person's note";
    applyCheckPlan(v, planCheck(v, [verdict({ kind: "node", id: "n1" }, "wrong", { field: "label", value: "open media database" })], ROUTES, "build"));
    expect(v.flowcharts[0].charts[0].nodes[0]).toMatchObject({ label: "open media database", description: "a person's note" });
  });

  it("understand: a re-check replaces its open issues on what it judged again", () => {
    const u = pieceView(feature("understand"), "pc_1");
    const wrong = (why: string) => verdict({ kind: "criterion", id: "ac_s2", storyId: "s2" }, "wrong", undefined, why);
    applyCheckPlan(u, planCheck(u, [wrong("list lives elsewhere")], [], "understand", "pc_1"));
    applyCheckPlan(u, planCheck(u, [wrong("the list is somewhere else")], [], "understand", "pc_1"));
    expect(u.issues?.filter((i) => i.status === "open").map((i) => i.title)).toEqual(["the list is somewhere else"]);
    applyCheckPlan(u, planCheck(u, [verdict({ kind: "criterion", id: "ac_s2", storyId: "s2" }, "ok")], [], "understand", "pc_1"));
    expect(u.issues?.filter((i) => i.status === "open")).toEqual([]);
  });

  it("skips a fix when a person edited the field after it was planned", () => {
    const v = pieceView(feature(), "pc_1");
    const plan = planCheck(v, [verdict({ kind: "criterion", id: "ac_s2", storyId: "s2" }, "wrong", { field: "given", value: "logged out" })], ROUTES, "build");
    v.stories.find((s) => s.id === "s2")!.acceptance[0].given = "a person's edit";
    const c = applyCheckPlan(v, plan);
    expect(v.stories.find((s) => s.id === "s2")!.acceptance[0].given).toBe("a person's edit");
    expect(c.fixed).toBe(1); // only the /billing snap
  });
});

describe("unverified mark through update_criterion", () => {
  it("is set and cleared by the op, and an edit to the route / steps clears it", () => {
    const v = pieceView(feature(), "pc_1");
    const a = () => v.stories[0].acceptance[0];
    const op = (criterion: Record<string, unknown>) => applyStoryOpWith(v, { op: "update_criterion", storyId: "s1", criterionId: "ac_s1", criterion }, (p) => `${p}_x`);
    op({ unverified: "route /campaigns isn't in the app's routes" });
    expect(a().unverified).toMatch(/campaigns/);
    op({ given: "anything" });
    expect(a().unverified).toBeDefined(); // a text edit doesn't touch it
    op({ startPath: "/media-database" });
    expect(a().unverified).toBeUndefined();
    op({ unverified: "x" });
    op({ unverified: null });
    expect(a().unverified).toBeUndefined();
    op({ unverified: "x" });
    op({ steps: ["click 'Add media'"] });
    expect(a().unverified).toBeUndefined();
  });
});
