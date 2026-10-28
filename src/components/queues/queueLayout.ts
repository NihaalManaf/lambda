import dagre from "@dagrejs/dagre";
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { DiffState, RiskLevel } from "@/lib/types";
import type { QGEdge, QGNode, QueueGraph } from "@/lib/queues/types";
import { riskNumbers } from "@/components/viz/risk";

// Left-to-right dagre layout for queue graphs. Sizes are estimated from labels so nodes never reflow.

export type Pin = { id: string; n: number; level: RiskLevel };
export type QNodeData = QGNode & { pins: Pin[]; worst: RiskLevel | null; text?: string /* label minus words the view implies */ } & Record<string, unknown>;
export type QNode = Node<QNodeData>;
export type QEdge = Edge<QGEdge & Record<string, unknown>>;

const RANK: Record<RiskLevel, number> = { bad: 3, warn: 2, info: 1 };
export const worstOf = (levels: RiskLevel[]) =>
  levels.reduce<RiskLevel | null>((a, l) => (!a || RANK[l] > RANK[a] ? l : a), null);

// marker colours go into svg attributes, so they are literal hex (mirrors globals.css)
const HEX: Record<DiffState, string> = {
  added: "#2f8f5b",
  removed: "#d4462f",
  changed: "#c98a12",
  renamed: "#096ad0",
  same: "#181818",
  context: "#d3d0c8",
};
export const edgeHex = (e: QGEdge) => (e.role === "callback" ? HEX.removed : HEX[e.diff]);

// channel label: last two path segments ("draft/journo_v2")
export function shortLabel(n: QGNode) {
  if (n.kind !== "channel" || !n.label.includes("/")) return n.label;
  return n.label.split(/[/?#]/).filter(Boolean).slice(-2).join("/") || n.label;
}

export const isCron = (s: string) => s.trim().split(/\s+/).length === 5;

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const num = /^\d+$/;
const step = /^\*\/(\d+)$/;
function clock(h: string, m: string) {
  const hh = +h % 12 || 12;
  return `${hh}${+m ? `:${m.padStart(2, "0")}` : ""}${+h < 12 ? "am" : "pm"}`;
}

// "0 1 * * *" → "daily 1am"; unknown shapes come back unchanged
export function humanCron(c: string) {
  const f = c.trim().split(/\s+/);
  if (f.length !== 5) return c;
  const [m, h, dom, mon, dow] = f;
  const anyDay = dom === "*" && mon === "*" && dow === "*";
  if (f.every((x) => x === "*")) return "every minute";
  if (step.test(m) && h === "*" && anyDay) return `every ${m.match(step)![1]}m`;
  if (num.test(m) && h === "*" && anyDay) return "hourly";
  if (num.test(m) && step.test(h) && anyDay) return `every ${h.match(step)![1]}h`;
  if (!num.test(m) || !num.test(h) || mon !== "*") return c;
  const at = clock(h, m);
  if (dom === "*" && dow === "*") return `daily ${at}`;
  if (dom === "*" && dow === "1-5") return `weekdays ${at}`;
  if (dom === "*" && num.test(dow)) return `${DAYS[+dow % 7]} ${at}`;
  if (num.test(dom) && dow === "*") return `monthly ${at}`;
  return c;
}

const DOMAIN_W = 212;
const DOMAIN_H = 64;
const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)));

// words most labels in a view share ("sendblue" all over the sms view) say nothing: drop them
export function commonWords(nodes: QGNode[]): Set<string> {
  const named = nodes.filter((n) => n.kind === "producer" || n.kind === "consumer");
  const count = new Map<string, number>();
  for (const n of named) for (const w of new Set(n.label.toLowerCase().split(/\s+/))) count.set(w, (count.get(w) ?? 0) + 1);
  const min = Math.max(3, Math.ceil(named.length * 0.35));
  return new Set([...count].filter(([w, c]) => c >= min && w.length > 2).map(([w]) => w));
}
export const trimWords = (label: string, drop: Set<string>) => {
  const ws = label.split(/\s+/);
  const kept = ws.filter((w) => !drop.has(w.toLowerCase()));
  return kept.length && kept.length < ws.length ? kept.join(" ") : label;
};

export function nodeSize(n: QGNode, text = shortLabel(n)) {
  const len = text.length;
  switch (n.kind) {
    case "trigger":
      return { w: 44, h: 62 };
    case "producer":
      return { w: clamp(len * 7 + 78, 140, 230), h: 42 };
    case "channel":
      return { w: clamp(len * 6.6 + 54, 116, 220), h: 32 };
    case "consumer":
      return { w: clamp(len * 7 + 84, 150, 240), h: 46 };
    case "domain":
      return { w: DOMAIN_W, h: DOMAIN_H };
    default:
      return { w: 64, h: 28 };
  }
}

// overview: domain cards on a plain grid (no chain, no orphan column) so the board fits at full size.
// Cross-domain traffic is left to the domain views: on a grid those lines would only be spaghetti.
function gridLayout(g: QueueGraph, pinsOf: (n: QGNode) => Pin[]) {
  const cols = g.nodes.length <= 4 ? g.nodes.length : g.nodes.length <= 9 ? 3 : 4;
  const gx = 24;
  const gy = 22;
  const nodes: QNode[] = g.nodes.map((n, i) => {
    const pins = pinsOf(n);
    return {
      id: n.id,
      type: n.kind,
      position: { x: (i % cols) * (DOMAIN_W + gx), y: Math.floor(i / cols) * (DOMAIN_H + gy) },
      width: DOMAIN_W,
      height: DOMAIN_H,
      data: { ...n, pins, worst: worstOf(pins.map((x) => x.level)) ?? (n.sub === "bad" || n.sub === "warn" ? n.sub : null) },
    };
  });
  const rows = Math.ceil(g.nodes.length / Math.max(1, cols));
  return { nodes, edges: [] as QEdge[], width: cols * DOMAIN_W + (cols - 1) * gx, height: rows * DOMAIN_H + (rows - 1) * gy };
}

export function layoutQueue(g: QueueGraph) {
  const nums = riskNumbers(g.risks);
  const byId = new Map(g.risks.map((r) => [r.id, { r, n: nums.get(r.id)! }]));
  const pinsOf = (n: QGNode) =>
    n.riskIds.flatMap((id) => {
      const hit = byId.get(id);
      return hit ? [{ id, n: hit.n, level: hit.r.level }] : [];
    }).sort((a, b) => a.n - b.n);
  if (g.nodes.length && g.nodes.every((n) => n.kind === "domain")) return gridLayout(g, pinsOf);

  const drop = commonWords(g.nodes);
  const textOf = (n: QGNode) => (n.kind === "producer" || n.kind === "consumer" ? trimWords(n.label, drop) : shortLabel(n));
  const d = new dagre.graphlib.Graph();
  d.setGraph({ rankdir: "LR", nodesep: 24, ranksep: g.edges.some((e) => e.badges.length) ? 88 : 70, edgesep: 12, marginx: 8, marginy: 8 });
  d.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const n of g.nodes) {
    const { w, h } = nodeSize(n, textOf(n));
    d.setNode(n.id, { width: w, height: h });
  }
  for (const e of g.edges) if (e.from !== e.to && ids.has(e.from) && ids.has(e.to)) d.setEdge(e.from, e.to);
  dagre.layout(d);

  const nodes: QNode[] = g.nodes.map((n) => {
    const p = d.node(n.id);
    const text = textOf(n);
    const { w, h } = nodeSize(n, text);
    const pins = pinsOf(n);
    return {
      id: n.id,
      type: n.kind,
      position: { x: p.x - w / 2, y: p.y - h / 2 },
      width: w,
      height: h,
      // overview domain cards carry their worst level in `sub` instead of riskIds
      data: { ...n, text, pins, worst: worstOf(pins.map((x) => x.level)) ?? (n.kind === "domain" && (n.sub === "bad" || n.sub === "warn") ? n.sub : null) },
    };
  });

  const edges: QEdge[] = g.edges
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      type: "message",
      data: { ...e },
      markerEnd: { type: MarkerType.ArrowClosed, color: edgeHex(e), width: 15, height: 15 },
    }));

  const { width = 0, height = 0 } = d.graph();
  return { nodes, edges, width, height };
}
