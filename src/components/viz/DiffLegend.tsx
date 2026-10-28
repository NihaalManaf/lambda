import clsx from "clsx";
import type { DiffState } from "@/lib/types";
import { DIFF } from "./diffStyle";

const ITEMS: { d: DiffState; label: string }[] = [
  { d: "added", label: "new" },
  { d: "changed", label: "changed" },
  { d: "removed", label: "gone" },
  { d: "renamed", label: "renamed" },
  { d: "context", label: "nearby" },
];

export default function DiffLegend({ className }: { className?: string }) {
  return (
    <div className={clsx("flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-grey", className)}>
      {ITEMS.map(({ d, label }) => (
        <span key={d} className="inline-flex items-center gap-1.5">
          <span
            className="size-2.5 rounded-[3px] border"
            style={{
              background: d === "context" ? "var(--paper)" : DIFF[d].bar,
              borderColor: DIFF[d].border,
              borderStyle: DIFF[d].dashed ? "dashed" : "solid",
            }}
          />
          {label}
        </span>
      ))}
    </div>
  );
}
