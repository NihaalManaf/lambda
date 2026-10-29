import dagre from "@dagrejs/dagre";
import { nodeDescription } from "./descriptions";
import type { Edge, Node } from "@xyflow/react";
import type { FlowNode, Flowchart } from "@/lib/types";

// Top-down dagre layout. Sizes are estimated from label length so nodes never reflow.

export type Pin = { id: string; n: number; handled: boolean | null };
export type FlowNodeData = { label: string; description?: string; kind: FlowNode["kind"]; pins: Pin[]; fresh?: boolean };

export function nodeSize(n: FlowNode) {
  const w = Math.round(Math.min(190, Math.max(104, n.label.length * 7 + 40)));
  switch (n.kind) {
    case "decision":
      return { w: Math.max(150, w + 30), h: 92 };
    case "start":
    case "end":
      return { w: Math.max(96, w - 10), h: 38 };
    case "store":
      return { w, h: 60 };
    default:
      return { w, h: 48 };
  }
}

export function layoutChart(c: Flowchart) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 34, ranksep: 46, edgesep: 14, marginx: 8, marginy: 8 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of c.nodes) {
    const { w, h } = nodeSize(n);
    g.setNode(n.id, { width: w, height: h });
  }
  for (const e of c.edges) g.setEdge(e.from, e.to);
  dagre.layout(g);

  const pins = new Map<string, Pin[]>();
  c.edgeCases.forEach((ec, i) => pins.set(ec.nodeId, [...(pins.get(ec.nodeId) ?? []), { id: ec.id, n: i + 1, handled: ec.handled }]));

  const nodes: Node<FlowNodeData>[] = c.nodes.map((n) => {
    const p = g.node(n.id);
    const { w, h } = nodeSize(n);
    return {
      id: n.id,
      type: n.kind,
      position: { x: p.x - w / 2, y: p.y - h / 2 },
      width: w,
      height: h,
      data: { label: n.label, description: nodeDescription(n, c), kind: n.kind, pins: pins.get(n.id) ?? [] },
    };
  });

  const edges: Edge[] = c.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    sourceHandle: "out",
    targetHandle: "in",
    label: e.label,
    type: "smoothstep",
  }));

  const { width = 0, height = 0 } = g.graph();
  return { nodes, edges, width, height };
}
