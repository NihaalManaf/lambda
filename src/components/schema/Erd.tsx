"use client";

import "@xyflow/react/dist/base.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { Background, BackgroundVariant, ReactFlow, useReactFlow } from "@xyflow/react";
import clsx from "clsx";
import type { DiffState } from "@/lib/types";
import type { ErdGraph } from "@/lib/schema/types";
import { edgeStroke } from "@/components/viz/diffStyle";
import { riskNumbers } from "@/components/viz/risk";
import { layoutErd, OVERFLOW_ID, type TableNodeData } from "./erdLayout";
import { ErdCtx, erdEdgeTypes, erdNodeTypes } from "./TableNode";

// bottom gutter keeps the diff legend off the lowest node
const FIT_PAD = { x: 0.12, top: 0.12, bottom: "48px" } as const;

// ERD canvas: same chrome as FlowChart (static, fitView, maxZoom 1). Table ids persist across graphs,
// so switching migrations glides the shared tables instead of redrawing the board.

const DIFFS: DiffState[] = ["added", "removed", "changed", "renamed", "same", "context"];

function Markers() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden>
      <defs>
        {DIFFS.map((d) => {
          const p = {
            fill: "none",
            stroke: edgeStroke(d),
            strokeWidth: 1.4,
            strokeLinecap: "round" as const,
            style: { visibility: "visible" as const },
          };
          return [
            // many (fk side): crow's foot fanning into the child table
            <marker
              key={`m${d}`}
              id={`erd-many-${d}`}
              viewBox="0 0 14 12"
              refX="13"
              refY="6"
              markerWidth="14"
              markerHeight="12"
              markerUnits="userSpaceOnUse"
              orient="auto-start-reverse"
            >
              <path d="M3 6L13 1M3 6H13M3 6L13 11M1 1.5v9" {...p} />
            </marker>,
            // one (referenced pk): a single bar
            <marker
              key={`o${d}`}
              id={`erd-one-${d}`}
              viewBox="0 0 14 12"
              refX="13"
              refY="6"
              markerWidth="14"
              markerHeight="12"
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path d="M7 1.5v9M10 1.5v9" {...p} />
            </marker>,
          ];
        })}
      </defs>
    </svg>
  );
}

type FitOpts = { padding: typeof FIT_PAD; maxZoom: number; minZoom?: number; nodes?: { id: string }[] };

// the change is the subject: fit to changed tables only, and keep a small change readable
// (context tables may run off the edge; the canvas pans)
function fitOf(nodes: { id: string; data: unknown }[]): FitOpts {
  const hot = nodes.filter((n) => {
    const d = (n.data as Partial<TableNodeData>).t?.diff;
    return !!d && d !== "context" && d !== "same";
  });
  if (!hot.length || hot.length === nodes.length) return { padding: FIT_PAD, maxZoom: 1 };
  return { padding: FIT_PAD, maxZoom: 1, nodes: hot.map((n) => ({ id: n.id })), ...(hot.length <= 2 && { minZoom: 0.85 }) };
}

function Refit({ k, fit }: { k: unknown; fit: FitOpts }) {
  const rf = useReactFlow();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const id = requestAnimationFrame(() => rf.fitView({ ...fit, duration: 280 }));
    return () => cancelAnimationFrame(id);
  }, [k, fit, rf]);
  return null;
}

export default function Erd({
  graph,
  height,
  hover: hoverProp,
  onHover,
  onOpenTable,
  className,
}: {
  graph: ErdGraph;
  height?: number;
  hover?: string | null;
  onHover?: (id: string | null) => void;
  onOpenTable?: (name: string) => void;
  className?: string;
}) {
  const [own, setOwn] = useState<string | null>(null);
  const hover = hoverProp !== undefined ? hoverProp : own;
  const setHover = onHover ?? setOwn;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const pinNo = useMemo(() => riskNumbers(graph.risks), [graph.risks]);
  const laid = useMemo(() => layoutErd(graph, expanded, pinNo), [graph, expanded, pinNo]);
  const fit = useMemo(() => fitOf(laid.nodes), [laid]);

  // edges hide for the length of the node glide, then fade back on the settled paths
  const [settled, setSettled] = useState(laid);
  useEffect(() => {
    if (settled === laid) return;
    const id = window.setTimeout(() => setSettled(laid), 260);
    return () => window.clearTimeout(id);
  }, [laid, settled]);

  const ctx = useMemo(
    () => ({
      hover,
      setHover,
      openTable: onOpenTable,
      toggle: (id: string) =>
        setExpanded((cur) => {
          const next = new Set(cur);
          if (!next.delete(id)) next.add(id);
          return next;
        }),
    }),
    [hover, setHover, onOpenTable],
  );

  const h = height ?? Math.round(Math.min(600, Math.max(260, laid.height + 64)));

  return (
    <ErdCtx.Provider value={ctx}>
      <div data-erd="" data-settling={settled !== laid ? "" : undefined} className={clsx("relative w-full bg-paper", className)} style={{ height: h }}>
        <Markers />
        <ReactFlow
          nodes={laid.nodes}
          edges={laid.edges}
          nodeTypes={erdNodeTypes}
          edgeTypes={erdEdgeTypes}
          onNodeClick={(_, n) => n.id !== OVERFLOW_ID && onOpenTable?.(n.id)}
          fitView
          fitViewOptions={fit}
          minZoom={0.25}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          nodesFocusable={false}
          zoomOnScroll={false}
          zoomOnPinch
          zoomOnDoubleClick={false}
          panOnScroll={false}
          preventScrolling={false}
          panOnDrag
          proOptions={{ hideAttribution: false }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="var(--line-2)" />
          <Refit k={laid} fit={fit} />
        </ReactFlow>
      </div>
    </ErdCtx.Provider>
  );
}
