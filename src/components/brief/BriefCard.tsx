"use client";

import { motion, useReducedMotion } from "motion/react";
import clsx from "clsx";
import type { Brief } from "@/lib/types";

const ease = [0.23, 1, 0.32, 1] as const;

// The settled intake brief, visually: summary · roles · in / out · decisions · pieces.
// Sections rise in with a short stagger (rare view: the moment the intake lands, or the brief tab).
export default function BriefCard({ brief, compact, className }: { brief: Brief; compact?: boolean; className?: string }) {
  const reduce = useReducedMotion();
  const rise = (i: number) => ({
    initial: { opacity: 0, transform: reduce ? "none" : "translateY(6px)" },
    animate: { opacity: 1, transform: "translateY(0px)" },
    transition: { duration: 0.32, ease, delay: reduce ? 0 : 0.04 + i * 0.05 },
  });

  return (
    <div className={clsx("card space-y-5", compact ? "p-5" : "p-6 md:p-8", className)}>
      <motion.p {...rise(0)} className={clsx("font-serif leading-snug text-ink", compact ? "text-[19px]" : "text-[22px] md:text-[26px]")}>
        {brief.summary}
      </motion.p>

      {brief.roles.length > 0 && (
        <motion.div {...rise(1)} className="flex flex-wrap items-center gap-1.5">
          <span className="eyebrow mr-1">for</span>
          {brief.roles.map((r) => (
            <span key={r} className="chip !text-[12px]">
              {r}
            </span>
          ))}
        </motion.div>
      )}

      {(brief.inScope.length > 0 || brief.outOfScope.length > 0) && (
        <motion.div {...rise(2)} className="grid gap-4 md:grid-cols-2">
          <ScopeList label="in" items={brief.inScope} />
          <ScopeList label="out" items={brief.outOfScope} muted />
        </motion.div>
      )}

      {brief.decisions.length > 0 && (
        <motion.div {...rise(3)}>
          <div className="eyebrow mb-2">settled</div>
          <ul className="divide-y divide-line rounded-2xl bg-paper-2/70">
            {brief.decisions.map((d, i) => (
              <li key={i} className="grid grid-cols-1 gap-x-3 gap-y-0.5 px-3.5 py-2.5 text-[13px] md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                <span className="text-grey">{d.q}</span>
                <span className="hidden text-grey/60 md:inline" aria-hidden>
                  →
                </span>
                <span className="text-ink">{d.a}</span>
              </li>
            ))}
          </ul>
        </motion.div>
      )}

      {brief.pieces.length > 0 && (
        <motion.div {...rise(4)}>
          <div className="eyebrow mb-2">{brief.pieces.length === 1 ? "1 piece · 1 pr" : `${brief.pieces.length} pieces · 1 pr each`}</div>
          <ol className="flex flex-wrap items-stretch gap-2">
            {brief.pieces.map((p, i) => (
              <li key={i} className="flex min-w-0 items-center gap-2">
                {i > 0 && (
                  <span className="text-grey/60" aria-hidden>
                    →
                  </span>
                )}
                <div className="min-w-0 max-w-[320px] rounded-2xl border border-line bg-card px-3 py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="display text-xl leading-none">{i + 1}</span>
                    <span className="line-clamp-2 text-[13px] font-semibold leading-snug">{p.title}</span>
                  </div>
                  {p.why && <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-grey">{p.why}</div>}
                </div>
              </li>
            ))}
          </ol>
        </motion.div>
      )}

      {!compact && (brief.surfaces.length > 0 || brief.openQuestions.length > 0) && (
        <motion.div {...rise(5)} className="grid gap-4 md:grid-cols-2">
          {brief.surfaces.length > 0 && (
            <div>
              <div className="eyebrow mb-2">touches</div>
              <div className="flex flex-wrap gap-1.5">
                {brief.surfaces.map((s) => (
                  <span key={s} className="rounded-md bg-paper-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}
          {brief.openQuestions.length > 0 && (
            <div>
              <div className="eyebrow mb-2">still open</div>
              <ul className="space-y-1 text-[13px] text-ink-2">
                {brief.openQuestions.map((q) => (
                  <li key={q} className="flex gap-2">
                    <span className="text-grey" aria-hidden>
                      ?
                    </span>
                    {q}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </motion.div>
      )}
    </div>
  );
}

function ScopeList({ label, items, muted }: { label: string; items: string[]; muted?: boolean }) {
  if (!items.length) return <div />;
  return (
    <div>
      <div className="eyebrow mb-2">{label}</div>
      <ul className="flex flex-wrap gap-1.5">
        {items.map((s) => (
          <li
            key={s}
            className={clsx(
              "rounded-full border px-2.5 py-1 text-[12px] leading-tight",
              muted ? "border-dashed border-line-2 text-grey" : "border-line bg-card text-ink",
            )}
          >
            {s}
          </li>
        ))}
      </ul>
    </div>
  );
}
