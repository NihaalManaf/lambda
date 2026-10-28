"use client";

import { createContext, useContext } from "react";
import { Handle, Position, type NodeProps, type NodeTypes } from "@xyflow/react";
import clsx from "clsx";
import type { IconName } from "@/lib/types";
import type { ChannelKind, Consumer } from "@/lib/queues/types";
import { Icon } from "@/components/viz/icons";
import BadgeRow from "@/components/viz/BadgeRow";
import { DIFF } from "@/components/viz/diffStyle";
import { hovers } from "@/components/viz/risk";
import { humanCron, isCron, shortLabel, type QNode, type QNodeData } from "./queueLayout";

// Queue node shapes: cron/webhook triggers, producers, lilac channel pills, consumers, domain cards.
// Risk pins sit on the top-right corner like the flow edge-case pins.

type Ctx = { hover: string | null; setHover: (id: string | null) => void; selected: string | null; focus: string | null };
export const QCtx = createContext<Ctx>({ hover: null, setHover: () => {}, selected: null, focus: null });

type P = NodeProps<QNode>;

const LEVEL_DOT = { bad: "bg-bad", warn: "bg-warn", info: "bg-blue" } as const;

function Pins({ pins }: { pins: QNodeData["pins"] }) {
  const { hover, setHover } = useContext(QCtx);
  if (!pins.length) return null;
  return (
    <div className="absolute -right-2 -top-2.5 z-10 flex gap-0.5">
      {pins.slice(0, 3).map((p) => (
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
      {pins.length > 3 && <span className="self-center font-mono text-[10px] text-grey">+{pins.length - 3}</span>}
    </div>
  );
}

function Ports({ top }: { top?: number }) {
  const style = top === undefined ? undefined : { top };
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} style={style} />
      <Handle type="source" position={Position.Right} isConnectable={false} style={style} />
    </>
  );
}

// selection / risk-focus ring + diff colouring shared by every shape
function useLook(d: QNodeData, id: string) {
  const { selected, focus, hover } = useContext(QCtx);
  const look = DIFF[d.diff];
  const lit = selected === id || focus === id || d.riskIds.some((r) => hovers(hover, r));
  return {
    ring: clsx("transition-[box-shadow,opacity,transform] duration-200", lit && "shadow-[0_0_0_2px_var(--paper),0_0_0_4px_var(--lilac)]"),
    style: {
      opacity: look.opacity,
      ...(d.diff !== "same" && { borderColor: look.border, background: look.bg, borderStyle: look.dashed ? ("dashed" as const) : undefined }),
    },
    strike: look.strike ? "line-through decoration-bad/70" : "",
  };
}

const label = "min-w-0 truncate text-[12.5px] font-semibold leading-tight";

function Trigger({ id, data }: P) {
  const { ring, style } = useLook(data, id);
  const cron = isCron(data.sub);
  return (
    <div className="relative flex size-full flex-col items-center" title={cron ? data.sub : data.label}>
      <Ports top={22} />
      <div
        className={clsx("grid size-11 shrink-0 place-items-center rounded-full border-[1.5px] border-ink bg-ink text-paper", ring)}
        style={style}
      >
        <Icon name={cron ? "clock" : "globe"} size={18} />
      </div>
      <span className="pointer-events-none absolute top-[48px] whitespace-nowrap font-hand text-[13px] leading-none text-ink-2">
        {cron ? humanCron(data.sub) : data.label}
      </span>
      <Pins pins={data.pins} />
    </div>
  );
}

function Producer({ id, data }: P) {
  const { ring, style, strike } = useLook(data, id);
  return (
    <div
      className={clsx(
        "relative flex size-full items-center gap-2 rounded-xl border-[1.5px] border-ink bg-card px-2.5 shadow-[2px_3px_0_var(--line-2)]",
        ring,
      )}
      style={style}
      title={data.label}
    >
      <Ports />
      <Icon name="file" size={14} className="shrink-0 text-grey" />
      <span className={clsx(label, strike)}>{data.text ?? data.label}</span>
      <span className="ml-auto shrink-0 rounded-md bg-paper-2 px-1 font-mono text-[10px] text-grey">{data.sub}</span>
      <Pins pins={data.pins} />
    </div>
  );
}

function Cylinder({ text }: { text?: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <svg width={12} height={14} viewBox="0 0 12 14" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden>
        <ellipse cx="6" cy="3" rx="4.8" ry="2" />
        <path d="M1.2 3v8c0 1.1 2.1 2 4.8 2s4.8-.9 4.8-2V3" />
      </svg>
      {text && <span className="font-mono text-[9.5px] font-bold">{text}</span>}
    </span>
  );
}

const CHANNEL_ICON: Partial<Record<ChannelKind, IconName>> = {
  "qstash-url": "queue",
  "qstash-schedule": "cron",
  "gh-cron": "cron",
  pubsub: "globe",
  eventbridge: "bolt",
};

function ChannelGlyph({ kind }: { kind: string }) {
  if (kind === "sqs") return <Cylinder text="sqs" />;
  if (kind === "pg-cron") return <Cylinder />;
  if (kind === "qstash-queue")
    return (
      <span className="relative inline-block size-[14px] shrink-0">
        <Icon name="queue" size={12} className="absolute left-[3px] top-0 opacity-45" />
        <Icon name="queue" size={12} className="absolute left-0 top-[3px]" />
      </span>
    );
  return <Icon name={CHANNEL_ICON[kind as ChannelKind] ?? "queue"} size={14} className="shrink-0" />;
}

function Channel({ id, data }: P) {
  const { ring, style, strike } = useLook(data, id);
  return (
    <div
      className={clsx("relative flex size-full items-center gap-1.5 rounded-full border-[1.5px] border-ink bg-lilac px-3 text-ink", ring)}
      style={style}
      title={`${data.sub} · ${data.label}`}
    >
      <Ports />
      <ChannelGlyph kind={data.sub} />
      <span className={clsx(label, "font-mono text-[11.5px] font-medium", strike)}>{shortLabel(data)}</span>
      <Pins pins={data.pins} />
    </div>
  );
}

const AUTH: Record<Consumer["auth"], { tone: string; title: string }> = {
  "qstash-sig": { tone: "text-ok", title: "signature checked" },
  receiver: { tone: "text-ok", title: "signature checked" },
  "service-role": { tone: "text-grey", title: "service role key" },
  "sqs-lambda": { tone: "text-grey", title: "sqs trigger" },
  none: { tone: "text-bad", title: "no auth" },
  unknown: { tone: "text-line-2", title: "auth unknown" },
};

function ConsumerNode({ id, data }: P) {
  const { ring, style, strike } = useLook(data, id);
  const auth = AUTH[data.sub as Consumer["auth"]] ?? AUTH.unknown;
  return (
    <div
      className={clsx("relative flex size-full items-center gap-2 rounded-l-xl rounded-r-sm border-[1.5px] border-ink bg-card pl-2.5 pr-2", ring)}
      style={{ borderRightWidth: 5, borderRightStyle: "double", ...style }}
      title={data.label}
    >
      <Ports />
      <span title={auth.title} className={clsx("shrink-0", auth.tone)}>
        <Icon name={data.sub === "none" ? "warn" : "shield"} size={14} />
      </span>
      <span className={clsx(label, strike)}>{data.text ?? data.label}</span>
      <BadgeRow badges={data.badges.filter((b) => b.icon !== "shield")} max={2} className="ml-auto shrink-0" />
      <Pins pins={data.pins} />
    </div>
  );
}

// overview card: worst-risk dot, name, one count. No pins: hovering a risk row rings the card instead.
function Domain({ id, data }: P) {
  const { ring, style } = useLook(data, id);
  const parts = data.badges.filter((b) => ["flow", "queue", "bolt"].includes(b.icon)).reduce((n, b) => n + (Number(b.text) || 0), 0);
  const total = data.count ?? parts;
  return (
    <div
      className={clsx(
        "group relative flex size-full cursor-pointer items-center gap-2.5 rounded-[18px] border-[1.5px] border-ink bg-card px-4 shadow-[3px_4px_0_var(--line-2)] transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-[4px_6px_0_var(--line-2)]",
        ring,
      )}
      style={style}
      title={data.label}
    >
      <Ports />
      {data.worst && <span className={clsx("size-2.5 shrink-0 rounded-full", LEVEL_DOT[data.worst])} title={`${data.worst} risk`} />}
      <span className="display min-w-0 flex-1 truncate text-[19px] leading-none">{data.label}</span>
      {total > 0 && (
        <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[12px] text-ink-2" title={`${total} parts`}>
          <Icon name="flow" size={12} className="text-grey" />
          {total}
        </span>
      )}
    </div>
  );
}

function More({ id, data }: P) {
  const { ring } = useLook(data, id);
  return (
    <div
      className={clsx("relative grid size-full place-items-center rounded-full border-[1.5px] border-dashed border-ink-2 bg-paper-2 font-mono text-[11px] text-ink-2", ring)}
      title={data.label}
    >
      <Ports />+{data.count ?? data.label}
    </div>
  );
}

export const nodeTypes: NodeTypes = {
  trigger: Trigger,
  producer: Producer,
  channel: Channel,
  consumer: ConsumerNode,
  domain: Domain,
  more: More,
};
