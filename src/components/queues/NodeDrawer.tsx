"use client";

import { useCallback } from "react";
import { motion } from "motion/react";
import type { Badge, IconName, Risk } from "@/lib/types";
import type { QGEdge, QGNode } from "@/lib/queues/types";
import { Icon } from "@/components/viz/icons";
import RiskChip from "@/components/viz/RiskChip";
import ShowSource from "@/components/viz/ShowSource";
import { humanCron, isCron, shortLabel } from "./queueLayout";

// Selected node: label + kind, its message options as icon rows, file:line, and the snippet behind </>.

const KIND_ICON: Record<QGNode["kind"], IconName> = {
  trigger: "clock",
  producer: "file",
  channel: "queue",
  consumer: "shield",
  domain: "split",
  more: "split",
};

export default function NodeDrawer({
  node,
  edges,
  risks,
  onFocus,
  onClose,
}: {
  node: QGNode;
  edges: QGEdge[];
  risks: Risk[];
  onFocus: (r: Risk) => void;
  onClose: () => void;
}) {
  // option rows: the node's own badges, then every badge on edges touching it (deduped by title)
  const seen = new Set<string>();
  const rows: Badge[] = [...node.badges, ...edges.filter((e) => e.from === node.id || e.to === node.id).flatMap((e) => e.badges)].filter(
    (b) => !seen.has(b.title) && !!seen.add(b.title),
  );
  const mine = risks.filter((r) => node.riskIds.includes(r.id));
  const sub = node.kind === "trigger" && isCron(node.sub) ? humanCron(node.sub) : node.sub;
  const id = node.id;
  const load = useCallback(async () => {
    const res = await fetch(`/api/queues/nodes/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(res.statusText);
    const body = (await res.json()) as { snippet?: string };
    return body.snippet ?? "";
  }, [id]);

  return (
    <motion.div
      key={node.id}
      initial={{ opacity: 0, x: 8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: "spring", stiffness: 500, damping: 40 }}
      className="space-y-3"
    >
      <div className="flex items-start gap-2">
        <span className="mt-1 text-grey">
          <Icon name={KIND_ICON[node.kind]} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="display break-words text-[22px]">{shortLabel(node)}</div>
          <div className="mt-1 flex items-center gap-1.5 font-mono text-[10.5px] text-grey">
            <span className="rounded-md bg-paper-2 px-1">{node.kind}</span>
            {sub && <span className="truncate">{sub}</span>}
          </div>
        </div>
        <button onClick={onClose} title="close" className="grid size-6 place-items-center rounded-full text-grey transition-colors hover:bg-paper-2 hover:text-ink">
          <svg width={10} height={10} viewBox="0 0 10 10" stroke="currentColor" strokeWidth={1.5} aria-hidden>
            <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
          </svg>
        </button>
      </div>

      {rows.length > 0 && (
        <ul className="space-y-1">
          {rows.map((b) => (
            <li key={b.title} className="flex items-center gap-2 text-[12.5px] text-ink-2">
              <span className={b.tone === "bad" ? "text-bad" : b.tone === "warn" ? "text-warn" : b.tone === "ok" ? "text-ok" : "text-grey"}>
                <Icon name={b.icon} size={13} />
              </span>
              {b.title}
            </li>
          ))}
        </ul>
      )}

      {mine.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {mine.map((r) => (
            <RiskChip key={r.id} risk={r} onFocus={() => onFocus(r)} />
          ))}
        </div>
      )}

      {node.ref && (
        <div className="truncate font-mono text-[11px] text-grey" title={`${node.ref.file}:${node.ref.line}`}>
          {node.ref.file}:{node.ref.line}
        </div>
      )}
      {node.ref && <ShowSource load={load} lang="code" />}
    </motion.div>
  );
}
