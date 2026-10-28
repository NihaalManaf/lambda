"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import type { Risk } from "@/lib/types";
import { Icon } from "./icons";
import RiskChip from "./RiskChip";
import { groupRisks, hoverKey, hovers, orderRisks } from "./risk";

// bad → warn → info. Same-label risks merge into one chip ×N with a pin cluster; info folds into a count.
// Numbers match the canvas pins. The list scrolls inside its own box.

const spring = { type: "spring", stiffness: 500, damping: 40 } as const;

export default function RiskList({
  risks,
  onFocus,
  active,
  onHover,
}: {
  risks: Risk[];
  onFocus: (r: Risk) => void;
  active?: string | null;
  onHover?: (id: string | null) => void;
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  const ordered = orderRisks(risks);
  const num = new Map(ordered.map((r, i) => [r.id, i + 1]));
  const groups = groupRisks(ordered);
  const loud = groups.filter((g) => g[0].level !== "info");
  const info = groups.filter((g) => g[0].level === "info");
  const lit = (g: Risk[]) => g.some((r) => hovers(active, r.id));
  const showInfo = infoOpen || info.some(lit);

  if (!risks.length)
    return (
      <div className="flex items-center gap-1.5 text-[12px] text-ok">
        <Icon name="shield" size={13} /> no risks
      </div>
    );

  const row = (g: Risk[]) => {
    const on = lit(g);
    const ns = g.map((r) => num.get(r.id)!);
    return (
      <motion.li
        key={g[0].id}
        layout="position"
        initial={{ opacity: 0, y: -3 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={spring}
        onMouseEnter={() => onHover?.(hoverKey(g.map((r) => r.id)))}
        onMouseLeave={() => onHover?.(null)}
        className={clsx("flex items-center gap-2 rounded-xl px-1.5 py-1 transition-colors duration-150", on && "bg-lilac-soft")}
      >
        {/* a merged row's pins are a run (orderRisks keeps labels together): one pill "4–16" */}
        <span
          className={clsx(
            "grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full border border-ink px-1 font-mono text-[10px] font-bold tabular-nums transition-colors",
            on ? "bg-ink text-paper" : "bg-lilac text-ink",
          )}
        >
          {ns.length > 1 ? `${ns[0]}–${ns[ns.length - 1]}` : ns[0]}
        </span>
        <RiskChip risk={g[0]} count={g.length} active={on} onFocus={() => onFocus(g[0])} />
      </motion.li>
    );
  };

  return (
    <ul className="max-h-[320px] space-y-0.5 overflow-y-auto overscroll-contain pr-1">
      <AnimatePresence initial={false}>
        {loud.map(row)}
        {info.length > 0 && !showInfo && (
          <motion.li key="info-fold" layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <button
              type="button"
              onClick={() => setInfoOpen(true)}
              className="ml-1.5 inline-flex h-6 items-center gap-1.5 rounded-full border border-dashed border-line-2 px-2.5 font-mono text-[11px] text-grey transition-colors hover:border-ink hover:text-ink"
            >
              <span className="size-1.5 rounded-full bg-blue" />+{info.reduce((n, g) => n + g.length, 0)} info
            </button>
          </motion.li>
        )}
        {showInfo && info.map(row)}
      </AnimatePresence>
    </ul>
  );
}
