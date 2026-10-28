"use client";

import { createContext, memo, useContext } from "react";
import { BaseEdge, getSmoothStepPath, Handle, Position, type Edge, type EdgeProps, type EdgeTypes, type Node, type NodeProps, type NodeTypes } from "@xyflow/react";
import clsx from "clsx";
import type { DiffState } from "@/lib/types";
import type { ErdCol } from "@/lib/schema/types";
import BadgeRow from "@/components/viz/BadgeRow";
import { DIFF, edgeStroke } from "@/components/viz/diffStyle";
import { Icon } from "@/components/viz/icons";
import { hovers } from "@/components/viz/risk";
import { HEAD_H, ROW_H, type OverflowNodeData, type TableNodeData } from "./erdLayout";

// Table card: diff bar + serif name + icon badges, then one 22px row per column.

export type ErdCtxValue = {
  hover: string | null;
  setHover: (id: string | null) => void;
  toggle: (tableId: string) => void;
  openTable?: (name: string) => void;
};
export const ErdCtx = createContext<ErdCtxValue>({ hover: null, setHover: () => {}, toggle: () => {} });

const hidden = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 };

function Ports({ id }: { id: string }) {
  return (
    <>
      <Handle type="target" id={`${id}:t`} position={Position.Left} isConnectable={false} style={hidden} />
      <Handle type="source" id={`${id}:s`} position={Position.Right} isConnectable={false} style={hidden} />
    </>
  );
}

function Pins({ pins }: { pins: TableNodeData["pins"] }) {
  const { hover, setHover } = useContext(ErdCtx);
  if (!pins.length) return null;
  return (
    <div className="absolute -right-2 -top-2.5 z-10 flex gap-0.5">
      {pins.map((p) => (
        <span
          key={p.id}
          onMouseEnter={() => setHover(p.id)}
          onMouseLeave={() => setHover(null)}
          className={clsx(
            "grid size-[18px] cursor-default place-items-center rounded-full border border-ink font-mono text-[10px] font-bold transition-transform duration-150",
            hovers(hover, p.id) ? "scale-125 bg-ink text-paper" : "bg-lilac text-ink",
          )}
        >
          {p.n}
        </span>
      ))}
    </div>
  );
}

const Mini = ({ children, tone }: { children: React.ReactNode; tone: string }) => (
  <span
    className="shrink-0 whitespace-nowrap rounded-full px-1 font-mono text-[9.5px] leading-[14px]"
    style={{ color: tone, background: "var(--card)" }}
  >
    {children}
  </span>
);

function change(c: ErdCol) {
  const b = c.before;
  if (!b) return null;
  if (b.type !== undefined && b.type !== c.type) return `${b.type} → ${c.type}`;
  if (b.required !== undefined && b.required !== c.required) return `${b.required ? "●" : "○"} → ${c.required ? "●" : "○"}`;
  if (b.default !== undefined) return "default ↻";
  return null;
}

function Row({ c }: { c: ErdCol }) {
  const look = DIFF[c.diff];
  const tinted = c.diff !== "same" && c.diff !== "context";
  const pill = c.diff === "changed" ? change(c) : null;
  return (
    <>
      <div
        className="relative flex items-center gap-1.5 px-2.5 text-[12px]"
        style={{ height: ROW_H, background: tinted ? look.bg : undefined }}
        title={c.comment ?? c.fullType}
      >
        <Ports id={c.name} />
        <span className="grid w-3.5 shrink-0 place-items-center text-ink-2">
          {c.pk ? <Icon name="key" size={12} /> : c.fk ? <Icon name="link" size={12} /> : null}
        </span>
        {c.diff === "renamed" && c.from && (
          <span className="min-w-0 max-w-[35%] truncate font-mono text-[10px] text-grey line-through decoration-grey/60" title={c.from}>{c.from}</span>
        )}
        {c.diff === "renamed" && c.from && <span className="shrink-0 text-[10px] text-blue">→</span>}
        <span
          className={clsx("min-w-0 flex-1 truncate", c.pk && "font-semibold", look.strike && "line-through")}
          style={{ color: tinted ? look.text : undefined }}
        >
          {c.name}
        </span>
        {pill && <Mini tone="var(--warn)">{pill}</Mini>}
        <span className="shrink-0 font-mono text-[10.5px] text-grey">{c.type}</span>
        {c.indexed && <Icon name="index" size={10} className="shrink-0 text-grey" />}
        {c.unique && <span className="shrink-0 font-mono text-[9px] font-bold text-ink-2">1</span>}
        <span
          title={c.required ? "required" : "nullable"}
          className={clsx("size-[7px] shrink-0 rounded-full border border-ink-2", c.required && "bg-ink-2")}
        />
      </div>
      {!!c.enumValues?.length && (
        <div
          className="flex items-center gap-1 overflow-hidden pl-8 pr-2 [mask-image:linear-gradient(to_right,#000_85%,transparent)]"
          style={{ height: ROW_H, background: tinted ? look.bg : undefined }}
        >
          {c.enumValues.map((e) => {
            const d = DIFF[e.diff];
            const lit = e.diff === "added" || e.diff === "removed";
            return (
              <span
                key={e.v}
                className={clsx(
                  "shrink-0 rounded-full border px-1.5 font-mono text-[10.5px] leading-[15px]",
                  e.diff === "removed" && "line-through",
                )}
                style={{
                  borderColor: lit ? d.border : "var(--line-2)",
                  color: lit ? d.text : "var(--ink-2)",
                  background: lit ? d.bg : "var(--paper)",
                }}
              >
                {e.v}
              </span>
            );
          })}
        </div>
      )}
    </>
  );
}

function TableNode({ data }: NodeProps<Node<TableNodeData>>) {
  const { t, rows, hidden: more, fold, expanded, pins } = data;
  const { toggle } = useContext(ErdCtx);
  const look = DIFF[t.diff];
  const stub = t.origin === "stub";
  const tinted = t.diff !== "same" && t.diff !== "context";
  return (
    <div
      className={clsx(
        "erd-table relative size-full overflow-visible rounded-xl border-[1.5px] bg-card shadow-[2px_3px_0_var(--line-2)]",
        (look.dashed || stub) && "border-dashed",
      )}
      style={{ borderColor: t.diff === "same" ? "var(--ink)" : look.border, opacity: look.opacity }}
    >
      <div className="size-full overflow-hidden rounded-[10.5px]">
        <div
          className={clsx(
            "relative flex items-center gap-1.5 pl-3.5 pr-2",
            stub ? "border-b border-dashed border-line-2" : "border-b border-line",
          )}
          style={{ height: HEAD_H, background: tinted ? look.bg : undefined }}
        >
          <Ports id="" />
          <span className="absolute inset-y-0 left-0 w-1" style={{ background: look.bar }} />
          {t.from && <span className="min-w-0 max-w-[30%] truncate font-mono text-[10px] text-grey line-through" title={t.from}>{t.from}</span>}
          {t.from && <span className="shrink-0 text-[11px] text-blue">→</span>}
          <span
            className={clsx("min-w-0 flex-1 truncate font-serif", look.strike && "line-through")}
            style={{ fontSize: t.label.length > 26 ? 12.5 : t.label.length > 21 ? 13.5 : 15 }}
            title={t.label}
          >
            {t.label}
          </span>
          {t.rls && !t.badges.some((b) => b.icon === "lock") && (
            <span title="row security on" className="text-ink-2">
              <Icon name="lock" size={12} />
            </span>
          )}
          <BadgeRow badges={t.badges} max={3} />
        </div>
        {rows.map((c) => (
          <Row key={c.name} c={c} />
        ))}
        {fold && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggle(t.id);
            }}
            className="nodrag nopan flex w-full items-center gap-1.5 px-2.5 font-mono text-[10.5px] text-grey transition-colors hover:bg-paper-2 hover:text-ink"
            style={{ height: ROW_H }}
          >
            <span className={clsx("inline-block transition-transform duration-200", expanded && "rotate-180")}>⌄</span>
            {expanded ? "less" : `+${more}`}
          </button>
        )}
      </div>
      <Pins pins={pins} />
    </div>
  );
}

function OverflowNode({ data }: NodeProps<Node<OverflowNodeData>>) {
  const { openTable } = useContext(ErdCtx);
  return (
    <div className="group/ov relative size-full">
      <Handle type="target" position={Position.Left} isConnectable={false} style={hidden} />
      <div className="grid size-full place-items-center rounded-full border-[1.5px] border-dashed border-ink-2 bg-paper font-mono text-[11px] text-ink-2">
        +{data.names.length} tables
      </div>
      <div className="invisible absolute left-1/2 top-full z-20 mt-1 max-h-48 w-max min-w-full -translate-x-1/2 translate-y-[-2px] overflow-auto rounded-xl border border-line-2 bg-card p-1 opacity-0 shadow-[2px_3px_0_var(--line)] transition-[opacity,transform,visibility] duration-150 group-hover/ov:visible group-hover/ov:translate-y-0 group-hover/ov:opacity-100">
        {data.names.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => openTable?.(n)}
            className="nodrag nopan block w-full rounded-lg px-2 py-0.5 text-left font-mono text-[11px] text-ink-2 hover:bg-lilac-soft hover:text-ink"
          >
            {n.replace(/^public\./, "")}
          </button>
        ))}
      </div>
    </div>
  );
}

export type FkEdgeData = { diff: DiffState; cascade: boolean };

// fk edge: the "cascade" mark sits just outside the fk row (in the gap between ranks, never on a card),
// drawn in the edge's own colour; red only when the link itself is going away
function FkEdge(p: EdgeProps<Edge<FkEdgeData>>) {
  const [path] = getSmoothStepPath({ ...p, borderRadius: 10, offset: 16 });
  const d = p.data;
  const dir = p.sourcePosition === Position.Left ? -1 : 1;
  return (
    <>
      <BaseEdge path={path} style={p.style} markerStart={p.markerStart} markerEnd={p.markerEnd} />
      {d?.cascade && d.diff !== "context" && (
        <text
          x={p.sourceX + 22 * dir}
          y={p.sourceY - 5}
          textAnchor={dir > 0 ? "start" : "end"}
          className="pointer-events-none font-hand"
          style={{ fontSize: 12, fill: d.diff === "removed" ? "var(--bad)" : edgeStroke(d.diff === "same" ? "same" : d.diff), paintOrder: "stroke", stroke: "var(--paper)", strokeWidth: 3 }}
        >
          ⤓ cascade
        </text>
      )}
    </>
  );
}

export const erdEdgeTypes: EdgeTypes = { fk: memo(FkEdge) };

export const erdNodeTypes: NodeTypes = { table: memo(TableNode), overflow: memo(OverflowNode) };
