"use client";

import clsx from "clsx";
import type { Risk } from "@/lib/types";
import { Icon } from "./icons";
import { isOk, riskColor } from "./risk";

// Pill: level dot + ≤3-word label. Hover reveals the "why" in hand font.

export default function RiskChip({ risk, active, onFocus, count = 1 }: { risk: Risk; active?: boolean; onFocus?: () => void; count?: number }) {
  const ok = isOk(risk);
  return (
    <span className="group/risk relative inline-flex">
      <button
        type="button"
        onClick={onFocus}
        className={clsx(
          "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold transition-[background,border-color,transform] duration-150 active:scale-[0.97]",
          active ? "border-ink bg-lilac-soft" : "border-line-2 bg-card hover:border-ink",
        )}
      >
        {ok ? (
          <Icon name="shield" size={12} className="text-ok" />
        ) : (
          <span className="size-2 rounded-full" style={{ background: riskColor(risk) }} />
        )}
        <span className="whitespace-nowrap">{risk.label}</span>
        {count > 1 && <span className="font-mono text-[10.5px] font-normal text-grey">×{count}</span>}
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-30 mt-1.5 w-max max-w-56 translate-y-[-2px] rounded-lg border border-line-2 bg-paper px-2 py-1 font-hand text-[13px] leading-snug text-ink-2 opacity-0 shadow-[2px_3px_0_var(--line)] transition-[opacity,transform] duration-150 group-hover/risk:translate-y-0 group-hover/risk:opacity-100"
      >
        {count > 1 ? `${risk.why} (+${count - 1} more)` : risk.why}
      </span>
    </span>
  );
}
