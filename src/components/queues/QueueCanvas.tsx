"use client";

import "@xyflow/react/dist/base.css";
import { useMemo, useState } from "react";
import { Background, BackgroundVariant, ReactFlow, type EdgeTypes } from "@xyflow/react";
import clsx from "clsx";
import type { QGNode, QueueGraph } from "@/lib/queues/types";
import { layoutQueue, type QEdge, type QNode } from "./queueLayout";
import { nodeTypes } from "./qNodes";
import MessageEdge, { PlayCtx } from "./MessageEdge";

// React Flow canvas for one QueueGraph. Same feel as FlowChart: fixed layout, fit, pan only.

const edgeTypes: EdgeTypes = { message: MessageEdge };

export default function QueueCanvas({
  graph,
  dots = false,
  onSelect,
  onHoverNode,
  minH = 260,
  maxH = 620,
  className,
}: {
  graph: QueueGraph;
  dots?: boolean;
  onSelect?: (n: QGNode, at: { x: number; y: number }) => void;
  onHoverNode?: (n: QGNode) => void;
  minH?: number;
  maxH?: number;
  className?: string;
}) {
  const [play, setPlay] = useState(dots);
  const { nodes, edges, height } = useMemo(() => layoutQueue(graph), [graph]);
  const moving = useMemo(() => graph.edges.some((e) => e.dots > 0), [graph]);
  const h = Math.round(Math.min(maxH, Math.max(minH, height + 64)));
  // remount per graph so fitView re-runs on a new view
  const key = useMemo(() => graph.nodes.map((n) => n.id).join("|").slice(0, 400) + graph.nodes.length, [graph]);

  return (
    <PlayCtx.Provider value={play}>
      <div className={clsx("relative w-full min-w-0 bg-paper", className)} style={{ height: h }}>
        <ReactFlow<QNode, QEdge>
          key={key}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onSelect && ((ev, n) => onSelect(n.data, { x: ev.clientX, y: ev.clientY }))}
          onNodeMouseEnter={onHoverNode && ((_, n) => onHoverNode(n.data))}
          fitView
          fitViewOptions={{ padding: 0.14, maxZoom: 1 }}
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
        </ReactFlow>
        {moving && (
          <button
            onClick={() => setPlay((p) => !p)}
            title={play ? "pause messages" : "play messages"}
            aria-pressed={play}
            className="absolute bottom-2.5 left-2.5 z-10 grid size-7 place-items-center rounded-full border border-line-2 bg-card text-ink-2 transition-[transform,color,border-color] duration-150 hover:border-ink hover:text-ink active:scale-90"
          >
            <svg width={11} height={11} viewBox="0 0 12 12" fill="currentColor" aria-hidden>
              {play ? <path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" /> : <path d="M3 1.5l7 4.5-7 4.5z" />}
            </svg>
          </button>
        )}
      </div>
    </PlayCtx.Provider>
  );
}
