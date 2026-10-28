import clsx from "clsx";
import type { Badge } from "@/lib/types";
import { Icon } from "./icons";

// Tiny icon badges; anything past `max` folds into "+n".

const TONE: Record<NonNullable<Badge["tone"]>, string> = {
  ok: "text-ok border-ok/40",
  warn: "text-warn border-warn/50",
  bad: "text-bad border-bad/50",
  muted: "text-grey border-line-2",
};

export default function BadgeRow({ badges, max = 4, className }: { badges: Badge[]; max?: number; className?: string }) {
  if (!badges.length) return null;
  const shown = badges.slice(0, max);
  const rest = badges.length - shown.length;
  return (
    <span className={clsx("inline-flex items-center gap-1", className)}>
      {shown.map((b, i) => (
        <span
          key={i}
          title={b.title}
          className={clsx(
            "inline-flex h-[18px] items-center gap-0.5 rounded-full border bg-card px-1 font-mono text-[10px] leading-none",
            TONE[b.tone ?? "muted"],
            !b.tone && "text-ink-2",
          )}
        >
          <Icon name={b.icon} size={11} />
          {b.text && <span>{b.text}</span>}
        </span>
      ))}
      {rest > 0 && (
        <span
          title={badges
            .slice(max)
            .map((b) => b.title)
            .join(" · ")}
          className="inline-flex h-[18px] items-center rounded-full border border-line-2 bg-card px-1.5 font-mono text-[10px] text-grey"
        >
          +{rest}
        </span>
      )}
    </span>
  );
}
