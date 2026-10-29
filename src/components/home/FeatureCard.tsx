"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import clsx from "clsx";
import { featureMode, type Feature, type FeatureStatus } from "@/lib/types";
import { allRuns, allStories } from "@/lib/pieces";
import { ago } from "./time";

const STATUS: Record<FeatureStatus, string> = {
  shaping: "bg-lilac-soft border-lilac text-ink",
  ready: "bg-card border-blue/40 text-blue",
  building: "bg-card border-warn/40 text-warn",
  verifying: "bg-card border-blue/40 text-blue",
  done: "bg-card border-ok/40 text-ok",
};

export function FeatureCard({ f, onDelete }: { f: Feature; onDelete: () => void }) {
  const [arm, setArm] = useState(false);
  // disarm delete if the pointer wanders off
  useEffect(() => {
    if (!arm) return;
    const t = setTimeout(() => setArm(false), 2500);
    return () => clearTimeout(t);
  }, [arm]);

  const understand = featureMode(f) === "understand";
  const openIssues = (f.issues ?? []).filter((i) => i.status === "open").length;
  const stories = allStories(f);
  const passing = stories.filter((s) => s.status === "passing").length;
  const counts: [string, number][] = [
    ...(f.pieces.length > 1 ? [[understand ? "areas" : "pieces", f.pieces.length] as [string, number]] : []),
    ["stories", stories.length],
    ["flows", f.pieces.reduce((n, p) => n + p.flowcharts.reduce((m, s) => m + s.charts.length, 0), 0)],
    ["sketches", f.pieces.reduce((n, p) => n + p.mockups.length, 0)],
    ["runs", allRuns(f).length],
  ];

  return (
    <motion.div
      whileHover={{ y: -4 }}
      transition={{ type: "spring", stiffness: 380, damping: 26 }}
      className="group card relative flex h-full flex-col p-5 transition-shadow duration-200 hover:shadow-[0_18px_40px_-24px_rgba(24,24,24,0.45)]"
    >
      <Link href={`/f/${f.id}`} className="absolute inset-0 rounded-[18px]" aria-label={f.title} />

      <div className="flex items-center justify-between">
        {/* understand features never build: a lifecycle chip would read "shaping" forever */}
        <div className="flex min-w-0 items-center gap-3">
          {understand ? <span className="chip text-grey">understand</span> : <span className={clsx("chip", STATUS[f.status])}>{f.status}</span>}
          {understand && openIssues > 0 && (
            <span className="chip text-warn" title="open issues: what to fix or extend">
              {openIssues} issue{openIssues > 1 ? "s" : ""}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => (arm ? onDelete() : setArm(true))}
          onMouseLeave={() => setArm(false)}
          className={clsx(
            "relative z-10 rounded-full px-2.5 py-1 font-mono text-[11px] transition-all duration-150",
            arm
              ? "bg-bad text-white opacity-100"
              : "text-grey opacity-0 group-hover:opacity-100 hover:bg-paper-2 hover:text-ink focus-visible:opacity-100",
          )}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={arm ? "y" : "n"}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.12 }}
              className="block"
            >
              {arm ? "delete?" : "✕"}
            </motion.span>
          </AnimatePresence>
        </button>
      </div>

      <h3 className="display mt-4 line-clamp-2 text-[1.7rem] leading-[1.05]">{f.title}</h3>
      {f.brief && <p className="mt-2 line-clamp-1 text-sm text-grey">{f.brief}</p>}

      <div className="mt-auto pt-6">
        {stories.length > 0 && !understand && (
          <div className="mb-4 h-1 overflow-hidden rounded-full bg-paper-2">
            <motion.div
              className="h-full rounded-full bg-ok"
              initial={{ width: 0 }}
              animate={{ width: `${(passing / stories.length) * 100}%` }}
              transition={{ type: "spring", stiffness: 80, damping: 20, delay: 0.2 }}
            />
          </div>
        )}
        <div className="flex items-end justify-between gap-3">
          <dl className="flex gap-4">
            {counts.map(([k, n]) => (
              <div key={k} className={clsx(n === 0 && "opacity-40")}>
                <dd className="font-mono text-base leading-none text-ink">{n}</dd>
                <dt className="mt-1 font-mono text-[10px] tracking-wider text-grey">{k}</dt>
              </div>
            ))}
          </dl>
          <span className="font-mono text-[11px] text-grey" suppressHydrationWarning>
            {ago(f.updatedAt)}
          </span>
        </div>
      </div>
    </motion.div>
  );
}
