"use client";

import { asA } from "@/components/stories/bits";
import FlagButton from "@/components/issues/FlagButton";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import type { Run } from "@/lib/runs";
import type { RunStatus, Story } from "@/lib/types";

const TONE: Record<RunStatus, string> = {
  queued: "text-grey border-line-2",
  running: "text-blue border-blue/40",
  passed: "text-ok border-ok/40",
  failed: "text-bad border-bad/40",
  error: "text-warn border-warn/40",
};
const DOT: Record<RunStatus, string> = { queued: "bg-grey", running: "bg-blue", passed: "bg-ok", failed: "bg-bad", error: "bg-warn" };

export const isActive = (s: RunStatus) => s === "queued" || s === "running";

export function StatusPill({ status }: { status: RunStatus }) {
  return (
    <span className={clsx("chip font-mono text-[11px] uppercase tracking-wider", TONE[status])}>
      <span className="relative flex h-2 w-2">
        {isActive(status) && <span className={clsx("absolute inset-0 animate-ping rounded-full opacity-60", DOT[status])} />}
        <span className={clsx("relative h-2 w-2 rounded-full", DOT[status])} />
      </span>
      {status}
    </span>
  );
}

const shotUrl = (runId: string, name: string) => `/api/runs/${runId}/shots/${encodeURIComponent(name)}`;

function useElapsed(run: Run) {
  const [t, setT] = useState(() => Date.parse(run.finishedAt ?? run.startedAt));
  useEffect(() => {
    if (!isActive(run.status)) return;
    const i = setInterval(() => setT(Date.now()), 1000);
    return () => clearInterval(i);
  }, [run.status]);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Math.max(t, Date.parse(run.startedAt));
  const s = Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function RunPanel({ run, story, onCancel }: { run: Run; story?: Story; onCancel: () => void }) {
  const logRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const elapsed = useElapsed(run);
  const active = isActive(run.status);

  // follow the tail unless the user scrolled up
  useEffect(() => {
    const el = logRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [run.log.length]);

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
        <StatusPill status={run.status} />
        <span className="font-mono text-[12px] text-grey">{elapsed}</span>
        {(run.status === "failed" || run.status === "error") && (
          <FlagButton
            refTo={{ tab: "verify", id: run.id, label: (story?.want ?? "browser check").slice(0, 60) }}
            title={run.summary || `check failed: ${story?.want ?? "browser check"}`}
            detail={[story && `story: ${story.want}`, ...(run.failures ?? [])].filter(Boolean).join("\n")}
            source="verify"
            label="log as issue"
            className="ml-auto"
          />
        )}
        {active && (
          <button
            className="btn btn-ghost ml-auto !py-1 !text-[12px]"
            disabled={cancelling}
            onClick={() => {
              setCancelling(true);
              onCancel();
            }}
          >
            {cancelling ? "stopping…" : "cancel"}
          </button>
        )}
      </div>

      {story && (
        <div className="px-5 pt-4">
          <div className="eyebrow">{asA(story.role)} {story.role}</div>
          <div className="mt-1 text-[15px] font-semibold leading-snug">{story.want}</div>
        </div>
      )}

      <AnimatePresence initial={false}>
        {!active && run.summary && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            transition={{ type: "spring", stiffness: 300, damping: 32 }}
            className="overflow-hidden"
          >
            <div className="px-5 pt-4">
              <p className="display text-2xl leading-tight">{run.summary}</p>
              {!!run.failures?.length && (
                <ul className="mt-3 space-y-1.5">
                  {run.failures.map((f, i) => (
                    <motion.li
                      key={i}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.08 * i }}
                      className="font-hand text-[17px] leading-snug text-marker"
                    >
                      ✗ {f}
                    </motion.li>
                  ))}
                </ul>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {run.shots.length > 0 && (
        <div className="flex gap-2 overflow-x-auto px-5 pt-4 pb-1">
          {run.shots.map((n) => (
            <motion.button
              key={n}
              layoutId={`shot-${run.id}-${n}`}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              onClick={() => setZoom(n)}
              className="group relative h-20 w-32 shrink-0 overflow-hidden rounded-lg border border-line bg-paper-2"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={shotUrl(run.id, n)} alt={n} className="h-full w-full object-cover object-top transition-transform duration-300 group-hover:scale-105" />
              <span className="absolute inset-x-0 bottom-0 truncate bg-ink/70 px-1.5 py-0.5 text-left font-mono text-[10px] text-paper">
                {n.replace(/\.(png|jpe?g|webp)$/i, "")}
              </span>
            </motion.button>
          ))}
        </div>
      )}

      <div ref={logRef} className="mt-4 max-h-[340px] overflow-y-auto border-t border-line bg-paper px-5 py-3 font-mono text-[12px] leading-[1.7]">
        {run.log.map((l, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className={clsx(
              "truncate",
              l.startsWith("→") && "text-grey",
              l.startsWith("✗") && "text-bad",
              l.startsWith("done") && "text-ok",
              !/^(→|✗|done)/.test(l) && "text-ink-2",
            )}
            title={l}
          >
            {l}
          </motion.div>
        ))}
        {active && <div className="shimmer mt-1 h-3 w-24 rounded" />}
      </div>

      <AnimatePresence>
        {zoom && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-8 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setZoom(null)}
          >
            <motion.div layoutId={`shot-${run.id}-${zoom}`} className="max-h-full max-w-5xl overflow-hidden rounded-xl bg-card shadow-2xl">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={shotUrl(run.id, zoom)} alt={zoom} className="max-h-[85vh] w-auto" />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
