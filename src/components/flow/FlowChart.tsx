"use client";

import "@xyflow/react/dist/base.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import clsx from "clsx";
import type { ChangeNote } from "@/lib/ops";
import type { EdgeCase, Flowchart, FlowNodeKind } from "@/lib/types";
import type { GraphOp } from "@/lib/flow-graph";
import { EdgeEditor, NodeEditor } from "./Editors";
import { Icon } from "./glyphs";
import { layoutChart, type FlowNodeData } from "./layout";
import { EditCtx, HoverCtx, nodeTypes } from "./nodes";
import Popover from "./Popover";

// One small chart: editable canvas on the left, numbered edge cases on the right.
// Click a node → popover (rename / kind / + step / + branch / + edge case / delete). Click an edge → label / delete.
// Connect mode: drag node → node. Every edit is optimistic; nodes glide between dagre layouts.

type Handled = EdgeCase["handled"];
// a chart-scoped op, minus the ids this component already knows
type Local<T> = T extends unknown ? Omit<T, "setId" | "chartId"> : never;
export type ChartOp = Local<GraphOp>;

const STATES: { v: Handled; icon: string; title: string; on: string }[] = [
  { v: null, icon: "?", title: "undecided · needs a call", on: "bg-warn" },
  { v: true, icon: "✓", title: "handled · build covers it", on: "bg-ok" },
  { v: false, icon: "✗", title: "won't handle · out of scope", on: "bg-ink-2" },
];

// below this node labels drop under ~10px; the canvas grows (and pans) instead
const MIN_ZOOM = 0.75;

const edgeDefaults = {
  style: { stroke: "var(--ink)", strokeWidth: 1.4 },
  markerEnd: { type: MarkerType.ArrowClosed, color: "#181818", width: 16, height: 16 },
  labelStyle: { fontFamily: "var(--font-hand)", fontSize: 13, fill: "var(--blue)", cursor: "pointer" },
  labelBgStyle: { fill: "var(--paper)" },
  labelBgPadding: [4, 2] as [number, number],
  pathOptions: { borderRadius: 10 },
  interactionWidth: 18,
};

const easeOut = (p: number) => 1 - Math.pow(1 - p, 4);

// Glide nodes from wherever they are now to the new layout (interruptible; edges follow for free).
function useGlide(target: Node<FlowNodeData>[], reduce: boolean) {
  const [nodes, setNodes] = useState(target);
  const at = useRef(new Map(target.map((n) => [n.id, n.position])));
  const first = useRef(true);
  useEffect(() => {
    const seen = new Set(target.map((n) => n.id));
    for (const k of [...at.current.keys()]) if (!seen.has(k)) at.current.delete(k);
    const from = new Map(at.current);
    const mark = (ns: Node<FlowNodeData>[]) =>
      ns.map((n) => (first.current || from.has(n.id) ? n : { ...n, data: { ...n.data, fresh: true } }));
    const moves = target.some((n) => {
      const a = from.get(n.id);
      return a && (Math.abs(a.x - n.position.x) > 0.5 || Math.abs(a.y - n.position.y) > 0.5);
    });
    if (reduce || !moves) {
      target.forEach((n) => at.current.set(n.id, n.position));
      setNodes(mark(target));
      first.current = false;
      return;
    }
    const t0 = performance.now();
    const D = 380;
    let raf = 0;
    const tick = (t: number) => {
      const e = easeOut(Math.min(1, (t - t0) / D));
      const frame = mark(
        target.map((n) => {
          const a = from.get(n.id);
          if (!a) return n;
          return { ...n, position: { x: a.x + (n.position.x - a.x) * e, y: a.y + (n.position.y - a.y) * e } };
        }),
      );
      frame.forEach((n) => at.current.set(n.id, n.position));
      setNodes(frame);
      if (e < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    first.current = false;
    return () => cancelAnimationFrame(raf);
  }, [target, reduce]);
  return nodes;
}

export default function FlowChart(props: {
  chart: Flowchart;
  index: number;
  total: number;
  busy: boolean; // the model is redrawing this chart
  undo: number; // undo depth
  onToggle: (edgeCaseId: string, handled: Handled) => void;
  onOps: (ops: ChartOp[]) => ChangeNote[];
  onRefine: (instruction: string) => void;
  onUndo: () => void;
}) {
  return (
    <ReactFlowProvider>
      <Chart {...props} />
    </ReactFlowProvider>
  );
}

function Chart({
  chart,
  index,
  total,
  busy,
  undo,
  onToggle,
  onOps,
  onRefine,
  onUndo,
}: Parameters<typeof FlowChart>[0]) {
  const reduce = !!useReducedMotion();
  const rf = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [edgeAt, setEdgeAt] = useState<{ id: string; x: number; y: number } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [refining, setRefining] = useState(false);
  const [ask, setAsk] = useState("");

  const layout = useMemo(() => layoutChart(chart), [chart]);
  const nodes = useGlide(layout.nodes, reduce);
  const edges = useMemo<Edge[]>(
    () => layout.edges.map((e) => ({ ...e, ...edgeDefaults, ...(edgeAt?.id === e.id ? { style: { ...edgeDefaults.style, stroke: "var(--blue)", strokeWidth: 2 } } : {}) })),
    [layout.edges, edgeAt?.id],
  );

  // canvas only grows during a session: shrinking would jolt the page under the cursor.
  // Dense charts get a taller / wider canvas instead of being zoomed out (minZoom keeps labels legible).
  const wantH = Math.round(Math.min(860, Math.max(240, layout.height + 56)));
  const wantW = Math.round(Math.min(880, Math.max(380, layout.width + 96)));
  const [box, setBox] = useState({ h: wantH, w: wantW });
  if (wantH > box.h || wantW > box.w) setBox({ h: Math.max(box.h, wantH), w: Math.max(box.w, wantW) });

  // refit to the new layout's bounds as nodes glide there
  const firstFit = useRef(true);
  useEffect(() => {
    if (firstFit.current) {
      firstFit.current = false;
      return;
    }
    const t = window.setTimeout(
      () => rf.fitBounds({ x: 0, y: 0, width: layout.width, height: layout.height }, { padding: 0.14, duration: reduce ? 0 : 380 }),
      30,
    );
    return () => window.clearTimeout(t);
  }, [layout.width, layout.height, box.h, box.w, rf, reduce]);

  useEffect(() => {
    if (!connecting) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setConnecting(false);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [connecting]);

  const node = chart.nodes.find((n) => n.id === selected);
  const edge = chart.edges.find((e) => e.id === edgeAt?.id);
  const open = chart.edgeCases.filter((e) => e.handled === null).length;

  const anchorNode = useCallback(() => {
    const el = wrap.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(selected ?? "")}"]`);
    const r = el?.getBoundingClientRect();
    return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
  }, [selected]);
  const anchorEdge = useCallback(() => (edgeAt ? { left: edgeAt.x, top: edgeAt.y - 6, width: 0, height: 12 } : null), [edgeAt]);

  const run = (ops: ChartOp[]) => onOps(ops);
  const addAfter = (after: string, label: string, kind: FlowNodeKind, edgeLabel?: string) => {
    const [n] = run([{ op: "add_node", after, label, kind, ...(edgeLabel?.trim() ? { edgeLabel } : {}) }]);
    setSelected(n?.ref ?? null); // popover hops onto the new node
  };

  const connect = (c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    run([{ op: "add_edge", from: c.source, to: c.target }]);
  };

  const refine = () => {
    if (!ask.trim() || busy) return;
    onRefine(ask.trim());
    setAsk("");
    setRefining(false);
  };

  return (
    <HoverCtx.Provider value={{ hover, setHover }}>
      <EditCtx.Provider value={{ selected, connecting }}>
        <div id={`chart-${chart.id}`} className="card relative scroll-mt-24 overflow-hidden">
          <div className="flex items-center gap-3 border-b border-line py-2.5 pl-5 pr-2.5">
            <span className="font-mono text-[11px] text-grey">
              {String(index + 1).padStart(2, "0")}/{String(total).padStart(2, "0")}
            </span>
            <h3 className="display truncate text-2xl">{chart.title}</h3>
            <span className="hidden min-w-0 flex-1 truncate text-[13px] text-grey lg:block">{chart.summary}</span>
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              <Tool on={refining} title="what's wrong? · redraw" onClick={() => setRefining((v) => !v)} disabled={busy}>
                <Icon.wand />
              </Tool>
              <Tool on={connecting} title="connect · drag node → node" onClick={() => setConnecting((v) => !v)} disabled={busy}>
                <Icon.link />
              </Tool>
              <Tool title={undo ? `undo · ${undo} left` : "nothing to undo"} onClick={onUndo} disabled={busy || !undo}>
                <Icon.undo />
              </Tool>
            </div>
          </div>

          {/* one-line "what's wrong?" → model redraws only this chart */}
          <AnimatePresence initial={false}>
            {refining && (
              <motion.form
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0, transition: { duration: 0.14 } }}
                transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
                className="overflow-hidden border-b border-line bg-lilac-soft/50"
                onSubmit={(e) => {
                  e.preventDefault();
                  refine();
                }}
              >
                <div className="flex items-center gap-2 px-4 py-2">
                  <Icon.wand className="shrink-0 text-ink-2" />
                  <input
                    autoFocus
                    value={ask}
                    onChange={(e) => setAsk(e.target.value)}
                    onKeyDown={(e) => e.key === "Escape" && setRefining(false)}
                    placeholder="what's wrong? e.g. retry before the error"
                    aria-label="what's wrong with this chart"
                    className="min-w-0 flex-1 bg-transparent py-1 text-[14px] outline-none placeholder:text-grey"
                  />
                  <button type="submit" disabled={!ask.trim()} className="btn btn-primary !px-3 !py-1 text-[12px]">
                    redraw <Icon.arrow size={13} />
                  </button>
                </div>
              </motion.form>
            )}
          </AnimatePresence>

          <div className="flex flex-col md:flex-row">
            <div
              ref={wrap}
              className={clsx(
                "relative w-full min-w-0 flex-none bg-paper",
                chart.edgeCases.length ? "md:w-[min(var(--cw),calc(100%-18rem))]" : "md:flex-1",
              )}
              style={{ height: box.h, ["--cw" as string]: `${box.w}px` }}
            >
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.14, maxZoom: 1, minZoom: MIN_ZOOM }}
                minZoom={MIN_ZOOM}
                maxZoom={1}
                nodesDraggable={false}
                nodesConnectable={connecting}
                connectionMode={ConnectionMode.Loose}
                connectionRadius={36}
                connectionLineStyle={{ stroke: "var(--ink)", strokeWidth: 1.5, strokeDasharray: "4 4" }}
                isValidConnection={(c) => c.source !== c.target && !chart.edges.some((e) => e.from === c.source && e.to === c.target)}
                onConnect={connect}
                onNodeClick={(_, n) => {
                  if (connecting || busy) return;
                  setEdgeAt(null);
                  setSelected((s) => (s === n.id ? null : n.id));
                }}
                onEdgeClick={(e, ed) => {
                  if (connecting || busy) return;
                  setSelected(null);
                  setEdgeAt({ id: ed.id, x: e.clientX, y: e.clientY });
                }}
                elementsSelectable={false}
                edgesFocusable={false}
                nodesFocusable={false}
                zoomOnScroll={false}
                zoomOnPinch={false}
                zoomOnDoubleClick={false}
                panOnScroll={false}
                preventScrolling={false}
                panOnDrag={!connecting}
                deleteKeyCode={null}
                proOptions={{ hideAttribution: false }}
              >
                <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="var(--line-2)" />
              </ReactFlow>

              {/* hint: tells you the chart is editable without a paragraph */}
              <div className="pointer-events-none absolute bottom-2.5 left-3 font-mono text-[10px] uppercase tracking-[0.12em] text-grey/80">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={connecting ? "c" : "e"}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.12 }}
                    className={clsx(connecting && "rounded-full bg-lilac px-2 py-0.5 text-ink")}
                  >
                    {connecting ? "drag node → node · esc" : "click to edit"}
                  </motion.span>
                </AnimatePresence>
              </div>
            </div>

            {chart.edgeCases.length > 0 && (
              <EdgeCases
                cases={chart.edgeCases}
                open={open}
                hover={hover}
                setHover={setHover}
                onToggle={onToggle}
                onRemove={(id) => run([{ op: "remove_edge_case", edgeCaseId: id }])}
              />
            )}
          </div>

          {/* redraw in progress: shimmer over this chart only */}
          <AnimatePresence>
            {busy && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="absolute inset-0 z-10 grid place-items-center"
              >
                <div className="shimmer absolute inset-0 opacity-70" />
                <span className="chip relative">
                  <span className="size-1.5 animate-pulse rounded-full bg-lilac" /> redrawing
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <AnimatePresence>
          {node && (
            <Popover key={`n-${node.id}`} label={`edit ${node.label}`} anchor={anchorNode} onClose={() => setSelected(null)}>
              <NodeEditor
                key={node.id}
                node={node}
                onRename={(label) => {
                  if (label.trim() && label.trim() !== node.label) run([{ op: "rename_node", nodeId: node.id, label }]);
                  setSelected(null);
                }}
                onKind={(kind) => run([{ op: "set_node_kind", nodeId: node.id, kind }])}
                onAddStep={(label) => addAfter(node.id, label, "step")}
                onAddBranch={(when, then) => addAfter(node.id, then, "step", when || "else")}
                onAddCase={(text) => {
                  run([{ op: "add_edge_case", nodeId: node.id, text }]);
                  setSelected(null);
                }}
                onDelete={() => {
                  run([{ op: "remove_node", nodeId: node.id }]);
                  setSelected(null);
                }}
              />
            </Popover>
          )}
          {edge && (
            <Popover key={`e-${edge.id}`} label="edit edge" anchor={anchorEdge} onClose={() => setEdgeAt(null)}>
              <EdgeEditor
                edge={edge}
                onLabel={(label) => {
                  if (label.trim() !== (edge.label ?? "")) run([{ op: "update_edge", edgeId: edge.id, label: label.trim() || undefined }]);
                  setEdgeAt(null);
                }}
                onDelete={() => {
                  run([{ op: "remove_edge", edgeId: edge.id }]);
                  setEdgeAt(null);
                }}
              />
            </Popover>
          )}
        </AnimatePresence>
      </EditCtx.Provider>
    </HoverCtx.Provider>
  );
}

function Tool({
  children,
  title,
  onClick,
  on,
  disabled,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  on?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "grid size-8 place-items-center rounded-full transition-[background-color,color,transform] duration-150 active:scale-95 disabled:opacity-30",
        on ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function EdgeCases({
  cases,
  open,
  hover,
  setHover,
  onToggle,
  onRemove,
}: {
  cases: EdgeCase[];
  open: number;
  hover: string | null;
  setHover: (id: string | null) => void;
  onToggle: (id: string, h: Handled) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <aside className="w-full min-w-0 border-t border-line md:min-w-72 md:flex-1 md:border-l md:border-t-0">
      <div className="flex items-center gap-2 px-4 pb-1 pt-3">
        <span className="eyebrow">edge cases</span>
        {open > 0 && <span className="font-mono text-[11px] text-warn">{open} open</span>}
        {/* legend: what the three states mean, at a glance */}
        <span className="ml-auto flex items-center gap-2 font-mono text-[10px] text-grey" aria-label="legend">
          {STATES.map((s) => (
            <span key={String(s.v)} className="flex items-center gap-1" title={s.title}>
              <span className={clsx("grid size-3.5 place-items-center rounded-full text-[9px] font-bold text-paper", s.on)}>{s.icon}</span>
              {s.v === null ? "open" : s.v ? "handled" : "won't"}
            </span>
          ))}
        </span>
      </div>
      <ul className="px-2 pb-3">
        <AnimatePresence initial={false}>
          {cases.map((ec, i) => (
            <motion.li
              key={ec.id}
              layout="position"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              transition={{ type: "spring", duration: 0.3, bounce: 0 }}
              onMouseEnter={() => setHover(ec.id)}
              onMouseLeave={() => setHover(null)}
              className={clsx(
                "group/ec flex items-start gap-2.5 rounded-xl px-2 py-2 transition-colors duration-150",
                hover === ec.id && "bg-lilac-soft",
              )}
            >
              <span
                className={clsx(
                  "mt-px grid size-[18px] shrink-0 place-items-center rounded-full border border-ink font-mono text-[10px] font-bold transition-colors",
                  hover === ec.id ? "bg-ink text-paper" : "bg-lilac",
                )}
              >
                {i + 1}
              </span>
              <span
                className={clsx(
                  "flex-1 text-[13px] leading-snug transition-colors",
                  ec.handled === false && "text-grey line-through decoration-grey/60",
                  ec.handled === true && "text-ink-2",
                )}
              >
                {ec.text}
              </span>
              <button
                onClick={() => onRemove(ec.id)}
                title="remove edge case"
                aria-label="remove edge case"
                className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-grey opacity-0 transition-opacity duration-150 hover:text-bad focus-visible:opacity-100 group-hover/ec:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <Icon.close size={12} />
              </button>
              <Toggle value={ec.handled} onChange={(v) => onToggle(ec.id, v)} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </aside>
  );
}

function Toggle({ value, onChange }: { value: Handled; onChange: (v: Handled) => void }) {
  return (
    <div className="flex shrink-0 rounded-full border border-line-2 bg-card p-0.5" role="radiogroup" aria-label="decision">
      {STATES.map((s) => (
        <button
          key={String(s.v)}
          role="radio"
          aria-checked={value === s.v}
          aria-label={s.title}
          title={s.title}
          onClick={() => value !== s.v && onChange(s.v)}
          className="relative grid size-6 place-items-center rounded-full text-[12px] font-bold active:scale-90"
        >
          {value === s.v && (
            <motion.span
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 600, damping: 30 }}
              className={clsx("absolute inset-0 rounded-full", s.on)}
            />
          )}
          <span className={clsx("relative transition-colors", value === s.v ? "text-paper" : "text-grey hover:text-ink")}>{s.icon}</span>
        </button>
      ))}
    </div>
  );
}
