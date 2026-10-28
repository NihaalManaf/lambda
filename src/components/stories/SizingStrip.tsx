"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import type { Sizing } from "@/lib/types";
import { Icon, Legend } from "./bits";

const spring = { type: "spring", stiffness: 420, damping: 34 } as const;
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven"];

// Verdict headline + ordered slice rail (1 → 2 → 3). Click a slice to filter the board.
export default function SizingStrip({
  sizing,
  passing: passingIds,
  focus,
  onFocus,
  onRegenerate,
  onResize,
  onAddSlice,
  busy,
  touched,
}: {
  sizing: Sizing;
  passing: Set<string>; // story ids whose last browser run passed
  focus: string | null;
  onFocus: (sliceId: string | null) => void;
  onRegenerate: () => void;
  onResize: () => void;
  onAddSlice: (title: string) => void;
  busy: "generate" | "resize" | null;
  touched?: boolean; // stories have statuses / runs worth warning about
}) {
  // two-tap regenerate: first tap arms, second replaces. disarms after 4s.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  const split = sizing.verdict === "split" && sizing.slices.length > 1;
  const n = sizing.slices.length;
  const passing = (ids: string[]) => ids.filter((id) => passingIds.has(id)).length;

  return (
    <div className={clsx("card relative overflow-hidden p-6 md:p-7", busy === "resize" && "opacity-60")}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="eyebrow mb-2">sizing</div>
          <h2 className="display text-4xl md:text-5xl">
            {split ? (
              <>
                split into <span className="italic">{WORDS[n] ?? n}</span>
              </>
            ) : (
              <>
                ship as <span className="italic">one</span>
              </>
            )}
          </h2>
          <p className="mt-2 max-w-xl text-sm text-grey">{sizing.reason}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!split && <NewSlice onAdd={onAddSlice} compact />}
          <button className="btn btn-ghost" onClick={onResize} disabled={!!busy} title="re-run sizing, keep stories">
            {busy === "resize" ? "sizing…" : "re-size"}
          </button>
          <button
            className={clsx("btn", armed ? "btn-primary !bg-bad !border-bad" : "btn-ghost")}
            onClick={() => {
              if (!armed) return setArmed(true);
              setArmed(false);
              onRegenerate();
            }}
            disabled={!!busy}
            title="replace all stories"
          >
            {busy === "generate" ? "writing…" : armed ? (touched ? "lose edits + results?" : "replace all?") : "regenerate"}
          </button>
        </div>
      </div>

      {split && (
        <div className="-mx-1 mt-6 flex items-stretch gap-1 overflow-x-auto px-1 pb-1">
          {sizing.slices.map((sl, i) => {
            const on = focus === sl.id;
            const done = passing(sl.storyIds);
            return (
              <Fragment key={sl.id}>
                {i > 0 && <span className="self-center px-1 font-mono text-grey">→</span>}
                <motion.button
                  layout
                  transition={spring}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => onFocus(on ? null : sl.id)}
                  title={sl.why}
                  aria-pressed={on}
                  className={clsx(
                    "relative min-w-[150px] max-w-[240px] flex-1 rounded-2xl border px-4 py-3 text-left transition-colors",
                    on ? "border-ink bg-ink text-paper" : "border-line bg-paper hover:border-line-2",
                  )}
                >
                  {/* number + full title (wraps); the why lives in the tooltip and the column header below */}
                  <div className="flex items-start gap-2">
                    <span className="display text-3xl leading-none">{i + 1}</span>
                    <span className="min-w-0 break-words pt-0.5 text-sm font-semibold leading-snug">{sl.title}</span>
                  </div>
                  <div className="mt-2 flex items-center gap-2 font-mono text-[11px]">
                    <span>
                      {sl.storyIds.length} {sl.storyIds.length === 1 ? "story" : "stories"}
                    </span>
                    {done > 0 && <span className="text-ok">· {done} ✓</span>}
                  </div>
                  {/* progress hairline */}
                  <span className="absolute inset-x-4 bottom-0 h-[2px] overflow-hidden rounded-full">
                    <motion.span
                      className="block h-full bg-ok"
                      initial={false}
                      animate={{ width: `${sl.storyIds.length ? (done / sl.storyIds.length) * 100 : 0}%` }}
                      transition={spring}
                    />
                  </span>
                </motion.button>
              </Fragment>
            );
          })}
          <span className="self-center px-1 font-mono text-line-2">→</span>
          <NewSlice onAdd={onAddSlice} />
        </div>
      )}
      <div className="mt-5">
        <Legend />
      </div>
      {busy && <div className="shimmer absolute inset-x-0 bottom-0 h-[3px]" />}
    </div>
  );
}

// "+ slice" → inline title input. Enter adds, Escape cancels.
function NewSlice({ onAdd, compact }: { onAdd: (title: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!open) return;
    cancelled.current = false;
    ref.current?.focus();
  }, [open]);
  const done = () => {
    if (v.trim() && !cancelled.current) onAdd(v.trim());
    cancelled.current = true; // blur after Enter must not add twice
    setV("");
    setOpen(false);
  };
  return (
    <AnimatePresence initial={false} mode="popLayout">
      {open ? (
        <motion.input
          key="in"
          ref={ref}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.1 } }}
          value={v}
          onChange={(e) => setV(e.target.value)}
          onBlur={done}
          onKeyDown={(e) => {
            if (e.key === "Enter") done();
            if (e.key === "Escape") {
              cancelled.current = true;
              setV("");
              setOpen(false);
            }
          }}
          placeholder="slice title"
          aria-label="new slice title"
          className={clsx(
            "rounded-2xl border border-ink bg-card px-4 text-sm font-semibold outline-none shadow-[0_0_0_3px_rgba(231,163,255,.35)]",
            compact ? "h-[38px] w-44 rounded-full" : "min-w-[160px] self-stretch",
          )}
        />
      ) : (
        <motion.button
          key="btn"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.1 } }}
          onClick={() => setOpen(true)}
          title="add a slice"
          className={clsx(
            "inline-flex shrink-0 items-center justify-center gap-1 border border-dashed border-line-2 text-xs font-semibold text-grey transition-[color,border-color,transform] duration-150 hover:border-ink hover:text-ink active:scale-[0.97]",
            compact ? "h-[38px] rounded-full px-4" : "min-w-[96px] self-stretch rounded-2xl px-4",
          )}
        >
          <Icon name="plus" size={12} /> slice
        </motion.button>
      )}
    </AnimatePresence>
  );
}
