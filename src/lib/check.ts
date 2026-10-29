import type { CheckItem, CheckKind } from "./facts";
import type { NewIssue } from "./issues";
import type { FlowOp, StoryOp } from "./ops";
import { checkPath } from "./routes";
import type { FeatureMode, FlowchartSet, PieceCheck, Story } from "./types";

// Pure planning for the check stage (src/lib/grounding.ts runs it):
// (a) every criterion's startPath against the scanned routes: matches → ok, a confident snap → fixed, else
//     marked unverified;
// (b) the verifier session's lambda-check verdicts: "wrong" with a one-field fix → a story / flow op (applied
//     through applyStoryOp / applyFlowOp, never a parallel writer); else understand → an issue, build → the
//     criterion is marked unverified (stories / flow nodes: listed in piece.check.flags).
// Every op carries the value it was planned against: the commit skips it when a person edited it meanwhile.

type Target = { stories: Story[]; flowcharts: FlowchartSet[] };
export type Ref = { kind: CheckKind; id: string; storyId?: string; setId?: string; chartId?: string };
// tally: what the op counts as once applied (a cleared mark counts as nothing; a fix carrying a mark, both)
export type Tally = "fixed" | "flagged" | "both" | null;
export type PlannedOp = { op: StoryOp | FlowOp; ref: Ref; field: string; before: string; tally: Tally };
export type CheckPlan = {
  ops: PlannedOp[];
  issues: NewIssue[];
  judged: string[]; // understand: issue ref ids the verifier judged (their earlier check issues are replaced)
  flags: NonNullable<PieceCheck["flags"]>;
  counts: { ok: number; fixed: number; flagged: number; unsure: number }; // fixed / flagged as planned; the commit recounts
};

const ROUTE_MARK = "route "; // prefix of a route-check mark, so a later pass can clear it
const CRITERION_FIELDS = ["given", "when", "then", "startPath", "steps"] as const;
const STORY_FIELDS = ["role", "want", "soThat"] as const;
const words = (s: string, n: number) => s.trim().split(/\s+/).filter(Boolean).slice(0, n).join(" ");
export const counts = (t: Tally) => ({ fixed: t === "fixed" || t === "both" ? 1 : 0, flagged: t === "flagged" || t === "both" ? 1 : 0 });

// the ref resolved against the stories / flows (ids repeat across charts: set + chart pin a node down)
export function resolve(t: Target, r: Ref): Ref | undefined {
  if (r.kind === "story") return t.stories.some((s) => s.id === r.id) ? { kind: "story", id: r.id } : undefined;
  if (r.kind === "criterion") {
    const s = t.stories.find((x) => x.id === r.storyId && x.acceptance.some((a) => a.id === r.id)) ?? t.stories.find((x) => x.acceptance.some((a) => a.id === r.id));
    return s ? { kind: "criterion", id: r.id, storyId: s.id } : undefined;
  }
  const hits = t.flowcharts.flatMap((set) =>
    set.charts
      .filter((c) => (!r.setId || set.id === r.setId) && (!r.chartId || c.id === r.chartId))
      .filter((c) => (r.kind === "node" ? c.nodes.some((n) => n.id === r.id) : c.edgeCases.some((e) => e.id === r.id)))
      .map((c) => ({ setId: set.id, chartId: c.id })),
  );
  return hits.length === 1 ? { kind: r.kind, id: r.id, ...hits[0] } : undefined;
}

// the current value of a field, JSON-encoded (undefined when the target is gone)
export function valueOf(t: Target, r: Ref, field: string): string | undefined {
  const enc = (x: unknown) => JSON.stringify(x ?? null);
  if (r.kind === "story") {
    const s = t.stories.find((x) => x.id === r.id);
    return s ? enc((s as unknown as Record<string, unknown>)[field]) : undefined;
  }
  if (r.kind === "criterion") {
    const a = t.stories.find((x) => x.id === r.storyId)?.acceptance.find((x) => x.id === r.id);
    // a mark is planned against the route / steps it judged
    return a ? enc(field === "unverified" ? [a.startPath, a.steps] : (a as unknown as Record<string, unknown>)[field]) : undefined;
  }
  const c = t.flowcharts.find((s) => s.id === r.setId)?.charts.find((x) => x.id === r.chartId);
  if (r.kind === "node") {
    const n = c?.nodes.find((x) => x.id === r.id);
    return n ? enc(n.label) : undefined;
  }
  const e = c?.edgeCases.find((x) => x.id === r.id);
  return e ? enc(e.text) : undefined;
}

const criterionOp = (r: Ref, criterion: Record<string, unknown>): StoryOp => ({
  op: "update_criterion",
  storyId: r.storyId!,
  criterionId: r.id,
  criterion,
});

// (a) startPaths vs the scanned routes. No routes (no repo / not a next app) → nothing to say.
export function planRoutes(t: Target, routes: string[]): CheckPlan {
  const plan: CheckPlan = { ops: [], issues: [], judged: [], flags: [], counts: { ok: 0, fixed: 0, flagged: 0, unsure: 0 } };
  if (!routes.length) return plan;
  for (const s of t.stories)
    for (const a of s.acceptance) {
      const ref: Ref = { kind: "criterion", id: a.id, storyId: s.id };
      const v = checkPath(a.startPath, routes);
      if (v.kind === "ok") {
        plan.counts.ok++;
        if (a.unverified?.startsWith(ROUTE_MARK))
          plan.ops.push({ op: criterionOp(ref, { unverified: null }), ref, field: "unverified", before: valueOf(t, ref, "unverified")!, tally: null });
      } else if (v.kind === "snap") {
        plan.ops.push({ op: criterionOp(ref, { startPath: v.to }), ref, field: "startPath", before: valueOf(t, ref, "startPath")!, tally: "fixed" });
      } else {
        const why = `${ROUTE_MARK}${a.startPath} ${v.kind === "weak" ? v.why : "isn't in the app's routes"}`;
        plan.ops.push({ op: criterionOp(ref, { unverified: why }), ref, field: "unverified", before: valueOf(t, ref, "unverified")!, tally: "flagged" });
      }
    }
  return tally(plan);
}

function tally(plan: CheckPlan): CheckPlan {
  plan.counts.fixed = plan.ops.reduce((n, o) => n + counts(o.tally).fixed, 0);
  plan.counts.flagged = plan.ops.reduce((n, o) => n + counts(o.tally).flagged, 0) + plan.issues.length + plan.flags.length;
  return plan;
}

// a fix the ops can carry as-is, or undefined (→ issue / mark)
function plainFix(r: Ref, it: CheckItem, routes: string[]): { op: StoryOp | FlowOp; field: string } | undefined {
  const fix = it.fix;
  if (!fix) return undefined;
  const text = typeof fix.value === "string" ? fix.value.trim() : "";
  if (r.kind === "criterion" && (CRITERION_FIELDS as readonly string[]).includes(fix.field)) {
    if (fix.field === "steps") {
      const steps = (Array.isArray(fix.value) ? fix.value : fix.value.split("\n")).map((x) => x.trim()).filter(Boolean);
      return steps.length ? { op: criterionOp(r, { steps }), field: "steps" } : undefined;
    }
    if (!text) return undefined;
    // a route fix must be concrete (no [param] left) and land on a real route when we know them
    if (fix.field === "startPath" && (/\/\[[^/]*\](\/|$)/.test(text) || (routes.length && checkPath(text, routes).kind !== "ok"))) return undefined;
    return { op: criterionOp(r, { [fix.field]: text }), field: fix.field };
  }
  if (!text) return undefined;
  if (r.kind === "story" && (STORY_FIELDS as readonly string[]).includes(fix.field))
    return { op: { op: "update_story", storyId: r.id, [fix.field]: text } as StoryOp, field: fix.field };
  if (r.kind === "node" && fix.field === "label")
    return { op: { op: "rename_node", setId: r.setId!, chartId: r.chartId!, nodeId: r.id, label: text, keepDescription: true }, field: "label" };
  if (r.kind === "edgeCase" && fix.field === "text")
    return { op: { op: "update_edge_case", setId: r.setId!, chartId: r.chartId!, edgeCaseId: r.id, text }, field: "text" };
  return undefined;
}

// what an understand issue on a target points at (a criterion's issue sits on its story)
const issueRef = (r: Ref) => (r.kind === "criterion" ? r.storyId! : r.id);

function label(t: Target, r: Ref): string {
  if (r.kind === "story") return t.stories.find((s) => s.id === r.id)?.want ?? r.id;
  if (r.kind === "criterion") {
    const a = t.stories.find((s) => s.id === r.storyId)?.acceptance.find((x) => x.id === r.id);
    return a ? a.then || a.when : r.id;
  }
  const c = t.flowcharts.find((s) => s.id === r.setId)?.charts.find((x) => x.id === r.chartId);
  return (r.kind === "node" ? c?.nodes.find((n) => n.id === r.id)?.label : c?.edgeCases.find((e) => e.id === r.id)?.text) ?? r.id;
}

// (a) + (b). Verdicts on unknown ids are dropped (the model's, or deleted since).
export function planCheck(t: Target, items: CheckItem[], routes: string[], mode: FeatureMode, pieceId?: string): CheckPlan {
  const plan = planRoutes(t, routes);
  const seen = new Set<string>();
  for (const it of items) {
    const r = resolve(t, it.target);
    if (!r) continue;
    const key = `${r.kind}:${r.setId ?? ""}:${r.chartId ?? ""}:${r.id}`;
    if (seen.has(key)) continue; // one verdict per target
    seen.add(key);
    if (it.verdict === "ok") {
      plan.counts.ok++;
      if (mode === "understand") plan.judged.push(issueRef(r));
      continue;
    }
    if (it.verdict === "unsure") {
      plan.counts.unsure++;
      continue;
    }
    const why = it.why || "contradicted by the code";
    const fix = plainFix(r, it, routes);
    const mine = (o: PlannedOp, field: string) => o.ref.kind === "criterion" && o.ref.id === r.id && o.field === field;
    if (fix) {
      // the verifier's own route wins over the route pass on the same criterion
      const drop = fix.field === "startPath" ? ["startPath", "unverified"] : [fix.field];
      // a steps fix keeps the route pass's mark (an edit to steps would clear it): carried in the same op
      const routeMark = fix.field === "steps" ? plan.ops.find((o) => mine(o, "unverified")) : undefined;
      const a = r.kind === "criterion" ? t.stories.find((x) => x.id === r.storyId)?.acceptance.find((x) => x.id === r.id) : undefined;
      const carry =
        routeMark?.tally === "flagged"
          ? ((routeMark.op as Extract<StoryOp, { op: "update_criterion" }>).criterion.unverified as string)
          : fix.field === "steps" && !routeMark && a?.unverified?.startsWith(ROUTE_MARK) && !routes.length
            ? a.unverified
            : undefined;
      plan.ops = plan.ops.filter((o) => !drop.some((f) => mine(o, f)) && o !== routeMark);
      const op = carry ? criterionOp(r, { ...(fix.op as Extract<StoryOp, { op: "update_criterion" }>).criterion, unverified: carry }) : fix.op;
      plan.ops.push({ op, ref: r, field: fix.field, before: valueOf(t, r, fix.field)!, tally: carry ? "both" : "fixed" });
      if (mode === "understand") plan.judged.push(issueRef(r));
      continue;
    }
    if (mode === "understand") {
      const flows = r.kind === "node" || r.kind === "edgeCase";
      plan.issues.push({
        title: words(why, 10),
        detail: `${why}${it.evidence ? ` (${it.evidence})` : ""}`.slice(0, 600),
        kind: "bug",
        ref: { tab: flows ? "flows" : "stories", id: issueRef(r), label: words(label(t, r), 8) },
        ...(pieceId ? { pieceId } : {}),
      });
      plan.judged.push(issueRef(r));
    } else if (r.kind === "criterion") {
      const mark = `${why}${it.evidence ? ` (${it.evidence})` : ""}`.slice(0, 200);
      // a planned snap moves the startPath first: the mark rides on the same op (planned against the old value)
      const snap = plan.ops.find((o) => mine(o, "startPath"));
      plan.ops = plan.ops.filter((o) => !mine(o, "unverified") && o !== snap);
      if (snap) {
        const to = (snap.op as Extract<StoryOp, { op: "update_criterion" }>).criterion.startPath;
        plan.ops.push({ ...snap, op: criterionOp(r, { startPath: to, unverified: mark }), tally: "both" });
      } else plan.ops.push({ op: criterionOp(r, { unverified: mark }), ref: r, field: "unverified", before: valueOf(t, r, "unverified")!, tally: "flagged" });
    } else plan.flags.push({ kind: r.kind, id: r.id, why, ...(it.evidence ? { evidence: it.evidence } : {}) });
  }
  return tally(plan);
}
