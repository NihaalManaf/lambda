import "server-only";
import { z } from "zod";
import { applyGraphOp, isGraphOp, locate, spliceParts, splitChart, words } from "./flow-graph";
import { featurePrompt, generate } from "./llm";
import type { ChangeNote, FlowOp } from "./ops";
import { id, now } from "./store";
import {
  MAX_FLOW_NODES,
  type EdgeCase,
  type Feature,
  type FlowEdge,
  type FlowLens,
  type FlowNode,
  type Flowchart,
  type FlowchartSet,
} from "./types";

// Flowcharts: tiny charts per abstraction lens. Model drafts, server enforces caps.

export { splitChart };

const KINDS = ["start", "step", "decision", "end", "error", "external", "store"] as const;

const LENS_GUIDE: Record<FlowLens, string> = {
  "customer-journey": "user's pov. nodes = screens, user actions, decisions the user hits. one chart per sub-journey (e.g. onboarding / core action / recovery).",
  data: "data movement. nodes = reads, writes, transforms, stores (kind store), third-party apis (kind external). one chart per entity or pipeline.",
  infra: "request path through services, queues, jobs, caches, third parties (kind external), dbs (kind store). one chart per path (sync request / async job / webhook).",
  state: "lifecycle of the core entity. nodes = states (kind step), terminal states (end), failure states (error). edges = transitions; label every edge with its event (<= 3 words).",
  custom: "follow the focus exactly; pick whatever granularity makes it obvious.",
};

const SYSTEM = `
you draw SUPER simple flowcharts that expose edge cases and decisions. slop is the enemy of understanding.
hard rules:
- 1-5 charts. each chart <= ${MAX_FLOW_NODES} nodes, ideally 4-7. a big flow MUST be split into several small charts, each a coherent sub-journey with its own start and end. never one big chart.
- node label <= 5 words, a fragment ("enter email", "token valid?"). decisions end with "?".
- kinds: start, end (pills), step, decision (2+ labeled out-edges), error (failure the user sees), external (third party), store (db/cache/file).
- edge label <= 3 words, ONLY on decision branches ("yes", "no", "expired"), else null.
- node ids short and unique within a chart ("n1", "n2"...). edges reference those ids.
- edge cases: the unhappy paths not drawn as nodes — error, empty state, permission denied, timeout, double-submit, stale data, offline, rate limit. attach each to the node where it bites. <= 12 words. 2-6 per chart, only real ones.
- title <= 4 words. summary <= 12 words.
- choose the right granularity for the lens; skip trivial steps; no invented requirements.
`.trim();

const Out = z.object({
  title: z.string().describe("set title, <= 4 words"),
  charts: z.array(
    z.object({
      title: z.string(),
      summary: z.string(),
      nodes: z.array(z.object({ id: z.string(), label: z.string(), kind: z.enum(KINDS) })),
      edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().nullable() })),
      edgeCases: z.array(z.object({ nodeId: z.string(), text: z.string() })),
    }),
  ),
});


// Clean one model chart: trim labels, drop dangling/duplicate edges + orphan edge cases.
export function sanitizeChart(raw: z.infer<typeof Out>["charts"][number], lens: FlowLens): Flowchart {
  const seen = new Set<string>();
  const nodes: FlowNode[] = [];
  raw.nodes.forEach((n, i) => {
    const nid = n.id.trim() || `_auto${i}`; // can't collide with model ids
    if (seen.has(nid)) return;
    seen.add(nid);
    nodes.push({ id: nid, label: words(n.label, 5), kind: n.kind });
  });
  const kindOf = new Map(nodes.map((n) => [n.id, n.kind]));
  const pairs = new Set<string>();
  const edges: FlowEdge[] = [];
  for (const e of raw.edges) {
    const from = e.from.trim();
    const to = e.to.trim();
    const key = `${from}>${to}`;
    if (!kindOf.has(from) || !kindOf.has(to) || pairs.has(key)) continue;
    pairs.add(key);
    const labelled = lens === "state" || kindOf.get(from) === "decision";
    const label = labelled && e.label ? words(e.label, 3) : undefined;
    edges.push({ id: id("fe"), from, to, ...(label ? { label } : {}) });
  }
  const edgeCases: EdgeCase[] = raw.edgeCases
    .map((c) => ({ ...c, nodeId: c.nodeId.trim() }))
    .filter((c) => kindOf.has(c.nodeId) && c.text.trim())
    .map((c) => ({ id: id("ec"), nodeId: c.nodeId, text: words(c.text, 12), handled: null }));
  return { id: id("fc"), title: words(raw.title, 5), summary: words(raw.summary, 12), nodes, edges, edgeCases };
}

export async function generateFlows(feature: Feature, lens: FlowLens, focus?: string, signal?: AbortSignal): Promise<FlowchartSet> {
  const existing = feature.flowcharts.map((s) => `- ${s.lens}: ${s.charts.map((c) => c.title).join(", ")}`).join("\n");
  const prompt = [
    featurePrompt(feature),
    feature.stories.length
      ? `\nuser stories:\n${feature.stories.map((s) => `- as a ${s.role}, i want ${s.want}`).join("\n")}`
      : "",
    `\nlens: ${lens}\n${LENS_GUIDE[lens]}`,
    focus?.trim() ? `\nfocus: ${focus.trim()}` : "",
    existing ? `\nalready charted (don't repeat):\n${existing}` : "",
    "\ndraw the flow set.",
  ].join("\n");

  const out = await generate({ schema: Out, system: SYSTEM, prompt, maxTokens: 6000, signal });
  const charts = out.charts
    .slice(0, 5)
    .map((c) => sanitizeChart(c, lens))
    .filter((c) => c.nodes.length > 0)
    .flatMap((c) => splitChart(c));
  if (!charts.length) throw new Error("model returned no usable charts");
  return { id: id("fs"), lens, title: words(out.title, 5) || lens, charts, createdAt: now() };
}

// ---------- refine one chart ----------

const ChartOut = z.object({ chart: Out.shape.charts.element });

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// LLM rewrites ONE chart from a one-line instruction. Same rules + caps; decisions carry over by node label.
export async function refineChart(
  feature: Feature,
  set: FlowchartSet,
  chart: Flowchart,
  instruction: string,
  signal?: AbortSignal,
): Promise<Flowchart> {
  const label = new Map(chart.nodes.map((n) => [n.id, n.label]));
  const current = [
    `title: ${chart.title}`,
    `summary: ${chart.summary}`,
    `nodes:\n${chart.nodes.map((n) => `- ${n.id} [${n.kind}] ${n.label}`).join("\n")}`,
    `edges:\n${chart.edges.map((e) => `- ${e.from} -> ${e.to}${e.label ? ` (${e.label})` : ""}`).join("\n") || "- none"}`,
    `edge cases:\n${chart.edgeCases.map((c) => `- @${c.nodeId}: ${c.text}`).join("\n") || "- none"}`,
  ].join("\n");
  const prompt = [
    featurePrompt(feature),
    `\nlens: ${set.lens}\n${LENS_GUIDE[set.lens]}`,
    `\ncurrent chart:\n${current}`,
    `\nthe developer says: "${instruction.trim()}"`,
    "\nredraw ONLY this chart with that change. keep everything they didn't ask to change (ids, labels, edge cases). one chart.",
  ].join("\n");
  const out = await generate({ schema: ChartOut, system: SYSTEM, prompt, maxTokens: 3000, effort: "low", signal });
  const next = sanitizeChart(out.chart, set.lens);
  if (!next.nodes.length) throw new Error("model returned an empty chart");

  // keep handled/won't decisions where the node label + case text still match
  const decided = new Map<string, EdgeCase["handled"]>();
  for (const c of chart.edgeCases) if (c.handled !== null) decided.set(`${norm(label.get(c.nodeId) ?? "")}|${norm(c.text)}`, c.handled);
  const nextLabel = new Map(next.nodes.map((n) => [n.id, n.label]));
  for (const c of next.edgeCases) {
    const h = decided.get(`${norm(nextLabel.get(c.nodeId) ?? "")}|${norm(c.text)}`);
    if (h !== undefined) c.handled = h;
  }
  return { ...next, id: chart.id };
}

// ---------- undo history (last 10 versions per chart) ----------
// types.ts has no history field, so this lives in process memory (survives HMR via globalThis, not restarts).
// One stack is shared by every chart a split produced; undo restores the pre-edit chart in their place.

interface Version {
  before: Flowchart;
  after: string[];
}
const HISTORY_MAX = 10;
const g = globalThis as { __lambdaFlowHistory?: Map<string, Version[]> };
const history = (g.__lambdaFlowHistory ??= new Map<string, Version[]>());
const histKey = (featureId: string, chartId: string) => `${featureId}:${chartId}`;

function remember(featureId: string, v: Version) {
  const stack = history.get(histKey(featureId, v.before.id)) ?? [];
  history.delete(histKey(featureId, v.before.id));
  stack.push(v);
  if (stack.length > HISTORY_MAX) stack.shift();
  for (const cid of v.after) history.set(histKey(featureId, cid), stack);
}

export function undoDepth(featureId: string, chartId: string) {
  return history.get(histKey(featureId, chartId))?.length ?? 0;
}

// Mutates in place (call inside updateFeature). Restores the chart as it was before its last edit.
export function undoChart(feature: Feature, setId: string, chartId: string): ChangeNote {
  const key = histKey(feature.id, chartId);
  const stack = history.get(key);
  const v = stack?.pop();
  if (!stack || !v) throw new Error("nothing to undo");
  const set = feature.flowcharts.find((s) => s.id === setId);
  if (!set) throw new Error("flow set not found");
  const at = set.charts.findIndex((c) => v.after.includes(c.id));
  if (at < 0) throw new Error("chart not found");
  set.charts = set.charts.filter((c) => !v.after.includes(c.id));
  set.charts.splice(at, 0, v.before);
  for (const cid of v.after) history.delete(histKey(feature.id, cid));
  if (stack.length) history.set(histKey(feature.id, v.before.id), stack);
  return { sign: "~", what: "chart", label: `undo · ${words(v.before.title, 4)}`, tab: "flows", ref: v.before.id };
}

// ---------- the edit contract ----------

// Applies one FlowOp to the feature in place (call inside updateFeature). Graph edits are sync;
// refine_chart + draw_lens call the model. Every chart stays <= MAX_FLOW_NODES (split otherwise).
// Prefer prepareFlowOp for the slow ops: it keeps the model call outside the store lock.
export function applyFlowOp(feature: Feature, op: FlowOp): ChangeNote | Promise<ChangeNote> {
  if (isGraphOp(op)) {
    const r = applyGraphOp(feature, op);
    remember(feature.id, { before: r.before, after: r.after });
    // node/edge ids repeat across charts: point the card at the chart that holds the ref now (post-split)
    const holder = r.after.find((cid) => locateChart(feature, op.setId, cid)?.some(r.note.ref)) ?? r.after[0];
    return holder ? { ...r.note, scope: holder } : r.note;
  }
  return prepareFlowOp(feature, op).then((commit) => commit(feature));
}

function locateChart(feature: Feature, setId: string, chartId: string) {
  const c = feature.flowcharts.find((s) => s.id === setId)?.charts.find((x) => x.id === chartId);
  if (!c) return undefined;
  return {
    some: (ref?: string) =>
      !!ref && (c.nodes.some((n) => n.id === ref) || c.edges.some((e) => e.id === ref) || c.edgeCases.some((x) => x.id === ref)),
  };
}

export type SlowFlowOp = Extract<FlowOp, { op: "refine_chart" | "draw_lens" }>;
export const isSlowFlowOp = (op: { op: string }): op is SlowFlowOp => op.op === "refine_chart" || op.op === "draw_lens";

// Two phases so the store lock is never held during a model call:
// prepare (model call, against a snapshot, outside the lock) → commit (in place, inside updateFeature).
export async function prepareFlowOp(snapshot: Feature, op: SlowFlowOp, signal?: AbortSignal): Promise<(f: Feature) => ChangeNote> {
  if (op.op === "refine_chart") {
    if (!op.instruction.trim()) throw new Error("say what's wrong");
    const { set, chart } = locate(snapshot, op.setId, op.chartId);
    const drawnFrom = JSON.stringify(chart);
    const next = await refineChart(snapshot, set, chart, op.instruction, signal);
    return (f) => {
      // re-locate in the live feature: the chart may have moved while the model was thinking
      const { set: liveSet, chart: before, index } = locate(f, op.setId, op.chartId);
      // never clobber an edit that landed while the model was redrawing (throws → whole batch rolls back)
      if (JSON.stringify(before) !== drawnFrom) throw new Error("chart changed while redrawing — retry");
      const parts = splitChart(next);
      spliceParts(liveSet, index, parts);
      remember(f.id, { before, after: parts.map((p) => p.id) });
      return { sign: "~", what: "chart", label: words(next.title, 6) || "chart redrawn", tab: "flows", ref: parts[0].id };
    };
  }
  if (op.lens === "custom" && !op.focus?.trim()) throw new Error("custom lens needs a focus");
  const set = await generateFlows(snapshot, op.lens, op.focus, signal);
  return (f) => {
    f.flowcharts.push(set);
    return { sign: "+", what: "flow set", label: words(set.title, 6), tab: "flows", ref: set.id };
  };
}
