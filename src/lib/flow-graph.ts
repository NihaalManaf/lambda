import type { ChangeNote, FlowOp } from "@/lib/ops";
import { MAX_FLOW_NODES, type EdgeCase, type FlowEdge, type FlowNode, type Flowchart, type FlowchartSet } from "@/lib/types";

// Pure, deterministic flowchart edits. No server deps: the server applies them inside updateFeature
// (src/lib/flows.ts applyFlowOp) and the client runs the same code for optimistic updates, so ids match.

export type GraphOp = Exclude<FlowOp, { op: "refine_chart" } | { op: "draw_lens" }>;
export const isGraphOp = (op: FlowOp): op is GraphOp => op.op !== "refine_chart" && op.op !== "draw_lens";

export const words = (s: string, n: number) => s.trim().split(/\s+/).filter(Boolean).slice(0, n).join(" ");

// ---------- split (MAX_FLOW_NODES) ----------

// BFS order from roots (start nodes first), then anything unreachable.
function bfsOrder(c: Flowchart): string[] {
  const out = new Map<string, string[]>(c.nodes.map((n) => [n.id, []]));
  const indeg = new Map<string, number>(c.nodes.map((n) => [n.id, 0]));
  for (const e of c.edges) {
    out.get(e.from)?.push(e.to);
    if (indeg.has(e.to)) indeg.set(e.to, indeg.get(e.to)! + 1);
  }
  const roots = [
    ...c.nodes.filter((n) => n.kind === "start"),
    ...c.nodes.filter((n) => n.kind !== "start" && indeg.get(n.id) === 0),
  ].map((n) => n.id);
  const order: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];
  const push = (n: string) => {
    if (seen.has(n)) return;
    seen.add(n);
    queue.push(n);
  };
  const drain = () => {
    while (queue.length) {
      const cur = queue.shift()!;
      order.push(cur);
      out.get(cur)!.forEach(push);
    }
  };
  roots.forEach(push);
  drain();
  for (const n of c.nodes) {
    push(n.id);
    drain();
  }
  return order;
}

const list = (parts: number[]) => parts.map((p) => p + 1).join(", ");

// Split an oversized chart into balanced BFS chunks.
// Each part keeps <= max nodes: up to max-2 real nodes plus "from N" / "continue → N" connectors.
export function splitChart(c: Flowchart, max = MAX_FLOW_NODES): Flowchart[] {
  if (c.nodes.length <= max) return [c];
  const order = bfsOrder(c);
  const k = Math.ceil(order.length / (max - 2));
  const size = Math.ceil(order.length / k);
  const partOf = new Map<string, number>(order.map((nid, i) => [nid, Math.floor(i / size)]));
  const byId = new Map(c.nodes.map((n) => [n.id, n]));

  return Array.from({ length: k }, (_, p) => {
    const nodes: FlowNode[] = order.filter((nid) => partOf.get(nid) === p).map((nid) => ({ ...byId.get(nid)! }));
    const edges: FlowEdge[] = [];
    const inParts = new Set<number>();
    const outParts = new Set<number>();
    const inTargets: { to: string }[] = [];
    const outSources: { from: string; label?: string }[] = [];
    for (const e of c.edges) {
      const a = partOf.get(e.from)!;
      const b = partOf.get(e.to)!;
      if (a === p && b === p) edges.push({ ...e, id: `${e.id}_${p}` });
      else if (b === p) {
        inParts.add(a);
        inTargets.push({ to: e.to });
      } else if (a === p) {
        outParts.add(b);
        outSources.push({ from: e.from, label: e.label });
      }
    }
    const inId = `${c.id}_in`;
    const outId = `${c.id}_out`;
    if (inParts.size) {
      nodes.unshift({ id: inId, kind: "start", label: `from ${list([...inParts].sort())}` });
      for (const to of new Set(inTargets.map((t) => t.to))) edges.push({ id: `${c.id}_in_${to}_${p}`, from: inId, to });
    }
    if (outParts.size) {
      nodes.push({ id: outId, kind: "end", label: `continue → ${list([...outParts].sort())}` });
      const done = new Set<string>();
      for (const s of outSources) {
        if (done.has(s.from)) continue;
        done.add(s.from);
        edges.push({ id: `${c.id}_out_${s.from}_${p}`, from: s.from, to: outId, ...(s.label ? { label: s.label } : {}) });
      }
    }
    const ids = new Set(nodes.map((n) => n.id));
    return {
      id: `${c.id}_${p + 1}`,
      title: `${c.title.replace(/( · \d+\/\d+)+$/, "")} · ${p + 1}/${k}`, // no nested '· 1/2 · 1/2'
      summary: c.summary,
      ...(c.schedules ? { schedules: c.schedules.filter((s) => ids.has(s.nodeId)) } : {}),
      nodes,
      edges,
      edgeCases: c.edgeCases.filter((ec) => ids.has(ec.nodeId)),
    };
  });
}

// ---------- split families ----------

const SUFFIX = /( · \d+\/\d+)+$/;
const baseTitle = (t: string) => t.replace(SUFFIX, "");
const partNo = (t: string) => Number(/ · (\d+)\/\d+$/.exec(t)?.[1] ?? 0);
const CONNECTOR = /^(from |continue → )(.+)$/;

// Replace set.charts[index] with `parts` (a split of that chart). When the replaced chart was itself
// one part of an earlier split, every sibling is renumbered across the whole family ("t · 1/3".."t · 3/3")
// and "from N" / "continue → N" connectors are rewritten to the new numbers, so no two parts share a title.
export function spliceParts(set: FlowchartSet, index: number, parts: Flowchart[]) {
  const replaced = set.charts[index];
  set.charts.splice(index, 1, ...parts);
  if (parts.length < 2) return;
  const base = baseTitle(replaced.title);
  const family = set.charts.filter((c) => baseTitle(c.title) === base && (SUFFIX.test(c.title) || parts.includes(c)));
  if (family.length <= parts.length) return; // plain split: splitChart's numbering is already global
  const newNo = new Map(family.map((c, i) => [c.id, i + 1]));
  // old global number → new number (a re-split part maps to its first new piece)
  const oldMap = new Map<number, number>();
  for (const c of family) if (!parts.includes(c)) oldMap.set(partNo(c.title), newNo.get(c.id)!);
  oldMap.set(partNo(replaced.title), newNo.get(parts[0].id)!);
  // connectors minted by this split (ids `${replaced.id}_in|_out`) use local indices 1..k; inherited ones, old numbers
  const localMap = new Map(parts.map((p, i) => [i + 1, newNo.get(p.id)!]));
  const local = new Set([`${replaced.id}_in`, `${replaced.id}_out`]);
  for (const c of family) {
    for (const n of c.nodes) {
      const map = parts.includes(c) && local.has(n.id) ? localMap : oldMap;
      const m = CONNECTOR.exec(n.label);
      if (m && (n.kind === "start" || n.kind === "end"))
        n.label = m[1] + m[2].replace(/\d+/g, (d) => String(map.get(Number(d)) ?? d));
    }
    c.title = `${base} · ${newNo.get(c.id)}/${family.length}`;
  }
}

// ---------- lookup + deterministic ids ----------

export function locate(feature: { flowcharts: FlowchartSet[] }, setId: string, chartId: string): { set: FlowchartSet; chart: Flowchart; index: number } {
  const set = feature.flowcharts.find((s) => s.id === setId);
  if (!set) throw new Error("flow set not found");
  const index = set.charts.findIndex((c) => c.id === chartId);
  if (index < 0) throw new Error("chart not found");
  return { set, chart: set.charts[index], index };
}

const nodeOf = (c: Flowchart, nodeId: string) => {
  const n = c.nodes.find((x) => x.id === nodeId);
  if (!n) throw new Error("node not found");
  return n;
};

function nextNodeId(c: Flowchart) {
  const taken = new Set(c.nodes.map((n) => n.id));
  let k = c.nodes.reduce((m, n) => Math.max(m, Number(/^n(\d+)$/.exec(n.id)?.[1] ?? 0)), 0) + 1;
  while (taken.has(`n${k}`)) k++;
  return `n${k}`;
}

// Edge pairs are unique per chart, so the pair is a stable id on both client and server.
function edgeId(c: Flowchart, from: string, to: string) {
  let eid = `e_${from}_${to}`;
  for (let k = 2; c.edges.some((e) => e.id === eid); k++) eid = `e_${from}_${to}_${k}`;
  return eid;
}

function edgeCaseId(c: Flowchart, nodeId: string) {
  let k = c.edgeCases.filter((e) => e.nodeId === nodeId).length + 1;
  while (c.edgeCases.some((e) => e.id === `ec_${nodeId}_${k}`)) k++;
  return `ec_${nodeId}_${k}`;
}

const hasPair = (c: Flowchart, from: string, to: string) => c.edges.some((e) => e.from === from && e.to === to);

function link(c: Flowchart, from: string, to: string, label?: string) {
  if (from === to || hasPair(c, from, to)) return;
  const l = label ? words(label, 3) : "";
  c.edges.push({ id: edgeId(c, from, to), from, to, ...(l ? { label: l } : {}) });
}

// ---------- apply ----------

export interface GraphResult {
  note: ChangeNote;
  before: Flowchart; // snapshot of the chart before the edit (for undo)
  after: string[]; // ids of the chart(s) now standing in its place (>1 when split)
}

const note = (sign: ChangeNote["sign"], what: ChangeNote["what"], label: string, ref?: string): ChangeNote => ({
  sign,
  what,
  label: words(label, 6) || what,
  tab: "flows",
  ...(ref ? { ref } : {}),
});

// Mutates feature in place. Throws on bad references. Splits a chart that grows past MAX_FLOW_NODES.
export function applyGraphOp(feature: { flowcharts: FlowchartSet[] }, op: GraphOp): GraphResult {
  const { set, chart: c, index } = locate(feature, op.setId, op.chartId);
  const before: Flowchart = structuredClone(c);
  let n: ChangeNote;

  switch (op.op) {
    case "rename_node": {
      const node = nodeOf(c, op.nodeId);
      const label = words(op.label, 5);
      if (!label) throw new Error("label required");
      node.label = label;
      if (!op.keepDescription) delete node.description;
      n = note("~", "node", label, node.id);
      break;
    }
    case "set_node_kind": {
      const node = nodeOf(c, op.nodeId);
      node.kind = op.kind;
      delete node.description;
      n = note("~", "node", `${node.label} → ${op.kind}`, node.id);
      break;
    }
    case "add_node": {
      const label = words(op.label, 5);
      if (!label) throw new Error("label required");
      const nid = nextNodeId(c);
      c.nodes.push({ id: nid, label, kind: op.kind });
      if (op.after) {
        const prev = nodeOf(c, op.after);
        const outs = c.edges.filter((e) => e.from === prev.id);
        // a labeled edge or a decision = new branch; a plain step with one exit = splice in-line
        if (!op.edgeLabel && prev.kind !== "decision" && outs.length === 1) {
          const [old] = outs;
          c.edges = c.edges.filter((e) => e !== old);
          link(c, prev.id, nid, old.label);
          link(c, nid, old.to);
        } else link(c, prev.id, nid, op.edgeLabel);
      }
      n = note("+", "node", label, nid);
      break;
    }
    case "remove_node": {
      const node = nodeOf(c, op.nodeId);
      const ins = c.edges.filter((e) => e.to === node.id && e.from !== node.id);
      const outs = c.edges.filter((e) => e.from === node.id && e.to !== node.id);
      c.nodes = c.nodes.filter((x) => x.id !== node.id);
      c.edges = c.edges.filter((e) => e.from !== node.id && e.to !== node.id);
      c.edgeCases = c.edgeCases.filter((e) => e.nodeId !== node.id);
      if (c.schedules) c.schedules = c.schedules.filter((s) => s.nodeId !== node.id);
      // reconnect predecessors → successors; a branch label on the way in survives
      for (const i of ins) for (const o of outs) link(c, i.from, o.to, i.label);
      n = note("−", "node", node.label);
      break;
    }
    case "add_edge": {
      nodeOf(c, op.from);
      nodeOf(c, op.to);
      if (op.from === op.to) throw new Error("edge to itself");
      if (hasPair(c, op.from, op.to)) throw new Error("edge already exists");
      link(c, op.from, op.to, op.label);
      const e = c.edges[c.edges.length - 1];
      n = note("+", "edge", op.label ? words(op.label, 3) : "connection", e.id);
      break;
    }
    case "update_edge": {
      const e = c.edges.find((x) => x.id === op.edgeId);
      if (!e) throw new Error("edge not found");
      const l = op.label ? words(op.label, 3) : "";
      if (l) e.label = l;
      else delete e.label;
      n = note("~", "edge", l || "label cleared", e.id);
      break;
    }
    case "remove_edge": {
      const e = c.edges.find((x) => x.id === op.edgeId);
      if (!e) throw new Error("edge not found");
      c.edges = c.edges.filter((x) => x !== e);
      n = note("−", "edge", e.label ?? "connection");
      break;
    }
    case "add_edge_case": {
      nodeOf(c, op.nodeId);
      const text = words(op.text, 12);
      if (!text) throw new Error("text required");
      const ec: EdgeCase = { id: edgeCaseId(c, op.nodeId), nodeId: op.nodeId, text, handled: null };
      c.edgeCases.push(ec);
      n = note("+", "edge case", text, ec.id);
      break;
    }
    case "update_edge_case": {
      const ec = c.edgeCases.find((x) => x.id === op.edgeCaseId);
      if (!ec) throw new Error("edge case not found");
      const text = words(op.text, 12);
      if (!text) throw new Error("text required");
      ec.text = text;
      n = note("~", "edge case", text, ec.id);
      break;
    }
    case "remove_edge_case": {
      const ec = c.edgeCases.find((x) => x.id === op.edgeCaseId);
      if (!ec) throw new Error("edge case not found");
      c.edgeCases = c.edgeCases.filter((x) => x !== ec);
      n = note("−", "edge case", ec.text);
      break;
    }
  }

  const parts = splitChart(c);
  if (parts.length > 1) spliceParts(set, index, parts);
  return { note: n, before, after: parts.map((p) => p.id) };
}
