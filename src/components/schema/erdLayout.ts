import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import type { ErdCol, ErdGraph, ErdTable } from "@/lib/schema/types";
import { edgeStroke } from "@/components/viz/diffStyle";

// LR dagre: child tables (fk side) left of the tables they reference. Sizes are fixed per row so nodes never reflow.

export const NODE_W = 236;
export const HEAD_H = 34;
export const ROW_H = 22;

export type TableNodeData = {
  t: ErdTable;
  rows: ErdCol[];
  hidden: number; // collapsed cols behind the "+N" row
  fold: boolean; // a "+N" / "−" toggle row is drawn
  expanded: boolean;
  pins: { id: string; n: number }[];
};
export type OverflowNodeData = { names: string[] };

/** collapsed tables show pinned cols (changed | pk | fk); context tables only show their fk keys */
export function visibleRows(t: ErdTable, expanded: boolean) {
  const pinned = t.cols.filter((c) => c.pinned);
  const fold = pinned.length < t.cols.length && t.diff !== "context";
  if (expanded || !fold) return { rows: expanded ? t.cols : pinned, hidden: 0, fold };
  return { rows: pinned, hidden: t.cols.length - pinned.length, fold };
}

const tableH = (rows: ErdCol[], fold: boolean) =>
  HEAD_H + ROW_H * (rows.length + (fold ? 1 : 0)) + ROW_H * rows.filter((c) => c.enumValues?.length).length + 4;

export const OVERFLOW_ID = "__overflow";

export function layoutErd(g: ErdGraph, expanded: ReadonlySet<string>, pinNo: Map<string, number>) {
  const d = new dagre.graphlib.Graph({ multigraph: true });
  d.setGraph({ rankdir: "LR", nodesep: 28, ranksep: 90, marginx: 8, marginy: 8 });
  d.setDefaultEdgeLabel(() => ({}));

  const sized = g.tables.map((t) => {
    const { rows, hidden, fold } = visibleRows(t, expanded.has(t.id));
    return { t, rows, hidden, fold, h: tableH(rows, fold) };
  });
  for (const s of sized) d.setNode(s.t.id, { width: NODE_W, height: s.h });
  const ids = new Set(g.tables.map((t) => t.id));
  for (const e of g.edges) if (ids.has(e.from) && ids.has(e.to) && e.from !== e.to) d.setEdge(e.from, e.to, {}, e.id);
  if (g.overflow.length) d.setNode(OVERFLOW_ID, { width: 120, height: 32 });
  dagre.layout(d);

  const nodes: Node[] = sized.map(({ t, rows, hidden, fold, h }) => {
    const p = d.node(t.id);
    const data: TableNodeData = {
      t,
      rows,
      hidden,
      fold,
      expanded: expanded.has(t.id),
      pins: t.riskIds.filter((id) => pinNo.has(id)).map((id) => ({ id, n: pinNo.get(id)! })),
    };
    return { id: t.id, type: "table", position: { x: p.x - NODE_W / 2, y: p.y - h / 2 }, width: NODE_W, height: h, data };
  });
  if (g.overflow.length) {
    const p = d.node(OVERFLOW_ID);
    nodes.push({
      id: OVERFLOW_ID,
      type: "overflow",
      position: { x: p.x - 60, y: p.y - 16 },
      width: 120,
      height: 32,
      data: { names: g.overflow } satisfies OverflowNodeData,
    });
  }

  // edges hook onto the fk column row; a column hidden by collapse falls back to the header
  const rowsOf = new Map(sized.map((s) => [s.t.id, new Set(s.rows.map((c) => c.name))]));
  const handle = (table: string, col: string, side: "s" | "t") => (rowsOf.get(table)?.has(col) ? `${col}:${side}` : `:${side}`);
  const edges: Edge[] = g.edges
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .map((e) => {
      const stroke = edgeStroke(e.diff);
      return {
        id: e.id,
        source: e.from,
        target: e.to,
        sourceHandle: handle(e.from, e.fromCol, "s"),
        targetHandle: handle(e.to, e.toCol, "t"),
        type: "fk",
        data: { diff: e.diff, cascade: e.cascade },
        style: {
          stroke,
          strokeWidth: e.diff === "same" || e.diff === "context" ? 1.3 : 1.8,
          strokeDasharray: e.diff === "context" ? "4 3" : e.diff === "removed" ? "2 3" : undefined,
        },
        markerStart: `erd-many-${e.diff}`,
        markerEnd: `erd-one-${e.diff}`,
      };
    });

  const { width = 0, height = 0 } = d.graph();
  return { nodes, edges, width, height };
}
