"use client";

import { createContext, useContext } from "react";
import { Handle, Position, type Node, type NodeProps, type NodeTypes } from "@xyflow/react";
import { motion, useReducedMotion } from "motion/react";
import clsx from "clsx";
import type { FlowNodeData } from "./layout";

// Sketchbook node shapes, one per kind. Edge-case pins sit on the top-right corner.

type Hover = { hover: string | null; setHover: (id: string | null) => void };
export const HoverCtx = createContext<Hover>({ hover: null, setHover: () => {} });

// which node the popover is open on + whether "connect" mode is on
export const EditCtx = createContext<{ selected: string | null; connecting: boolean }>({ selected: null, connecting: false });

type P = NodeProps<Node<FlowNodeData>>;

function Pins({ pins }: { pins: FlowNodeData["pins"] }) {
  const { hover, setHover } = useContext(HoverCtx);
  if (!pins.length) return null;
  return (
    <div className="absolute -right-2 -top-2.5 z-10 flex gap-0.5">
      {pins.map((p) => (
        <span
          key={p.id}
          onMouseEnter={() => setHover(p.id)}
          onMouseLeave={() => setHover(null)}
          title={p.handled === null ? "edge case · undecided" : p.handled ? "edge case · handled" : "edge case · won't handle"}
          className={clsx(
            "grid size-[18px] place-items-center rounded-full border font-mono text-[10px] font-bold transition-[transform,background-color,color] duration-150",
            hover === p.id
              ? "scale-125 border-ink bg-ink text-paper"
              : p.handled === null
                ? "border-ink bg-lilac text-ink"
                : p.handled
                  ? "border-ok bg-card text-ok"
                  : "border-line-2 bg-paper-2 text-grey",
          )}
        >
          {p.n}
        </span>
      ))}
    </div>
  );
}

function Ports() {
  const { connecting } = useContext(EditCtx);
  return (
    <>
      <Handle id="in" type="target" position={Position.Top} isConnectable={false} />
      <Handle id="out" type="source" position={Position.Bottom} isConnectable={false} />
      {/* connect mode: the whole node is a drag handle (loose mode lets it be a drop target too) */}
      {connecting && (
        <Handle
          id="drag"
          type="source"
          position={Position.Bottom}
          isConnectable
          style={{ left: 0, top: 0, bottom: "auto", transform: "none", width: "100%", height: "100%", border: 0, borderRadius: 0, background: "transparent", cursor: "crosshair" }}
        />
      )}
    </>
  );
}

// Selection ring + entrance for nodes added after the chart first rendered.
function Shell({ id, data, children, round }: { id: string; data: FlowNodeData; children: React.ReactNode; round: string }) {
  const { selected, connecting } = useContext(EditCtx);
  const reduce = useReducedMotion();
  return (
    <motion.div
      title={!connecting && selected !== id ? data.description : undefined}
      initial={data.fresh && !reduce ? { opacity: 0, scale: 0.92 } : false}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", duration: 0.35, bounce: 0.15 }}
      className={clsx(
        "group/node relative size-full",
        connecting ? "cursor-crosshair" : "cursor-pointer",
      )}
    >
      <span
        aria-hidden
        className={clsx(
          "pointer-events-none absolute -inset-[5px] border-2 border-lilac transition-opacity duration-150",
          round,
          selected === id ? "opacity-100" : "opacity-0",
          connecting && "group-hover/node:opacity-60",
        )}
      />
      {children}
    </motion.div>
  );
}

const label = "px-3 text-center text-[12.5px] font-semibold leading-tight";

function Box({ id, data, className, round }: P & { className: string; round: string }) {
  return (
    <Shell id={id} data={data} round={round}>
      <div className={clsx("relative flex size-full items-center justify-center", round, className)}>
        <Ports />
        <span className={label} data-label>{data.label}</span>
        <Pins pins={data.pins} />
      </div>
    </Shell>
  );
}

function Svgish({ id, data, width = 0, height = 0, shape }: P & { shape: (w: number, h: number) => React.ReactNode }) {
  return (
    <Shell id={id} data={data} round="rounded-[22px]">
      <div className="relative flex size-full items-center justify-center">
        <svg className="absolute inset-0 overflow-visible" width={width} height={height} aria-hidden>
          {shape(width, height)}
        </svg>
        <Ports />
        <span className={clsx(label, "relative max-w-[66%] px-0")} data-label>
          {data.label}
        </span>
        <Pins pins={data.pins} />
      </div>
    </Shell>
  );
}

const stroke = { stroke: "var(--ink)", strokeWidth: 1.5, strokeLinejoin: "round" as const };

export const nodeTypes: NodeTypes = {
  start: (p: P) => <Box {...p} round="rounded-full" className="bg-ink text-paper" />,
  end: (p: P) => <Box {...p} round="rounded-full" className="border-[1.5px] border-ink bg-paper" />,
  step: (p: P) => <Box {...p} round="rounded-2xl" className="border-[1.5px] border-ink bg-card shadow-[2px_3px_0_var(--line-2)]" />,
  error: (p: P) => (
    <Box
      {...p}
      round="rounded-2xl"
      className="border-2 border-[var(--marker)] bg-card text-[var(--marker)] shadow-[2px_3px_0_rgba(226,56,43,0.15)]"
    />
  ),
  external: (p: P) => <Box {...p} round="rounded-2xl" className="border-[1.5px] border-dashed border-ink-2 bg-paper-2 text-ink-2" />,
  decision: (p: P) => (
    <Svgish
      {...p}
      shape={(w, h) => <polygon points={`${w / 2},1 ${w - 1},${h / 2} ${w / 2},${h - 1} 1,${h / 2}`} fill="var(--lilac-soft)" {...stroke} />}
    />
  ),
  store: (p: P) => (
    <Svgish
      {...p}
      shape={(w, h) => {
        const rx = w / 2 - 1;
        const ry = 7;
        return (
          <>
            <path d={`M1,${ry + 1} V${h - ry - 1} A${rx},${ry} 0 0 0 ${w - 1},${h - ry - 1} V${ry + 1}`} fill="var(--card)" {...stroke} />
            <ellipse cx={w / 2} cy={ry + 1} rx={rx} ry={ry} fill="var(--paper-2)" {...stroke} />
          </>
        );
      }}
    />
  ),
};
