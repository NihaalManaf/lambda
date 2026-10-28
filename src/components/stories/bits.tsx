"use client";

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import type { Feature, Priority, Story, VerificationRun } from "@/lib/types";

// Tiny shared pieces for the story board.

export const PRIORITIES: Priority[] = ["must", "should", "could"];
export const LEVEL: Record<Priority, number> = { must: 3, should: 2, could: 1 };
const BY_LEVEL: Priority[] = ["could", "should", "must"];
// "as a user" / "as an admin"
// vowel *sound*: "an admin", "an owner", but "a user", "a unique visitor", "a one-off buyer"
export const asA = (role: string) => {
  const r = role.trim().toLowerCase();
  const an = /^(?:[aeio]|u(?!s|ni|ri|ti)|hour|honest)/.test(r) && !/^(?:one|eu)/.test(r);
  return `as ${an ? "an" : "a"}`;
};

// ---------- live status: derived from the latest browser run, never hand-ticked ----------

export type Live = "untested" | "running" | "passing" | "failing";

export function lastRun(f: Feature, storyId: string): VerificationRun | undefined {
  let best: VerificationRun | undefined;
  for (const r of f.runs) if (r.storyId === storyId && (!best || r.startedAt > best.startedAt)) best = r;
  return best;
}

export function liveOf(story: Story, run?: VerificationRun): Live {
  if (run) return run.status === "passed" ? "passing" : run.status === "queued" || run.status === "running" ? "running" : "failing";
  return story.status === "passing" ? "passing" : story.status === "failing" ? "failing" : story.status === "building" ? "running" : "untested";
}

export const LIVE: Record<Live, { dot: string; text: string; label: string }> = {
  untested: { dot: "bg-line-2", text: "text-grey", label: "untested" },
  running: { dot: "bg-warn", text: "text-warn", label: "running" },
  passing: { dot: "bg-ok", text: "text-ok", label: "passing" },
  failing: { dot: "bg-bad", text: "text-bad", label: "failing" },
};

export function LiveIcon({ s, size = 14 }: { s: Live; size?: number }) {
  if (s === "running")
    return <span className="inline-block animate-spin rounded-full border-[1.5px] border-warn border-t-transparent" style={{ width: size - 3, height: size - 3 }} />;
  return <Icon name={s === "passing" ? "check" : s === "failing" ? "x" : "dash"} size={size} className={LIVE[s].text} />;
}

export function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-grey">
      {(Object.keys(LIVE) as Live[]).map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <span className={clsx("h-2 w-2 rounded-full", LIVE[k].dot)} />
          {LIVE[k].label}
        </span>
      ))}
    </div>
  );
}

// ---------- priority: 3-step meter (ascending bars, reads as "signal", never as a ••• menu) ----------

export function Meter({ p, onPick, big }: { p: Priority; onPick?: (p: Priority) => void; big?: boolean }) {
  const n = LEVEL[p];
  const h = big ? [6, 10, 14] : [5, 8, 11];
  return (
    <span className="group/meter inline-flex items-center gap-1.5" title={`priority: ${p}`}>
      <span className="inline-flex items-end">
        {[1, 2, 3].map((i) => (
          <button
            key={i}
            type="button"
            disabled={!onPick}
            aria-label={`priority ${BY_LEVEL[i - 1]}`}
            onClick={(e) => {
              e.stopPropagation();
              onPick?.(BY_LEVEL[i - 1]);
            }}
            className="flex h-4 items-end px-[1.5px] disabled:cursor-default"
          >
            <span
              className={clsx(
                "block rounded-[1.5px] transition-colors duration-150",
                big ? "w-[4px]" : "w-[3px]",
                i <= n ? "bg-ink" : "bg-line-2",
                onPick && i > n && "group-hover/meter:bg-grey/50",
              )}
              style={{ height: h[i - 1] }}
            />
          </button>
        ))}
      </span>
      {big && <span className="font-mono text-[11px] text-grey">{p}</span>}
    </span>
  );
}

// ---------- role: monogram chip ----------

const HUES = ["#f6e4ff", "#e4eefc", "#e3f1e8", "#fdf0d8", "#fde4df", "#ececec"];
const hue = (s: string) => HUES[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
const mono = (s: string) =>
  s
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase() || "?";

export function RoleChip({ role, children }: { role: string; children?: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span
        className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full font-mono text-[9.5px] font-semibold tracking-wide text-ink-2"
        style={{ background: hue(role.toLowerCase()) }}
        aria-hidden
      >
        {mono(role)}
      </span>
      {children ?? <span className="truncate text-[12px] font-semibold text-ink-2">{role}</span>}
    </span>
  );
}

// ---------- icons (1.6 stroke, currentColor) ----------

const PATHS: Record<string, ReactNode> = {
  given: <><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="1.6" fill="currentColor" /></>,
  when: <path d="M4 3.5 12 8l-8 4.5z" />,
  then: <path d="m3.5 8.5 3 3 6-7" />,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  x: <path d="m4.5 4.5 7 7m0-7-7 7" />,
  dash: <path d="M4.5 8h7" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  play: <path d="M5 3.5v9l7.5-4.5z" fill="currentColor" />,
  pencil: <path d="m10.5 3 2.5 2.5L6 12.5H3.5V10z" />,
  trash: <path d="M3.5 4.5h9m-7 0V3h5v1.5m-6 0 .5 8h6l.5-8" />,
  globe: <><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c2 2 2 9 0 11m0-11c-2 2-2 9 0 11" /></>,
  criteria: <><rect x="3" y="3" width="10" height="10" rx="2.5" /><path d="m5.5 8.2 1.8 1.8 3.2-3.6" /></>,
  close: <path d="m4.5 4.5 7 7m0-7-7 7" />,
};
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 14, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={clsx("shrink-0", className)}
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  );
}

// "2m ago"
export function ago(iso?: string) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Borderless inline-edit text: commits on blur / enter, escape reverts.
// Sizes to its content (field-sizing; `size` is the fallback). `multiline` wraps instead of clipping.
export function Inline({
  value,
  onCommit,
  className,
  placeholder,
  multiline,
  allowEmpty,
  label,
}: {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  placeholder?: string;
  multiline?: boolean;
  allowEmpty?: boolean;
  label?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const v = draft ?? value;
  const commit = () => {
    const t = draft?.trim();
    if (draft !== null && t !== value && (t || allowEmpty)) onCommit(t ?? "");
    setDraft(null);
  };
  // auto-height for browsers without field-sizing
  useLayoutEffect(() => {
    const t = area.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight}px`;
  }, [v]);
  const keys = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    }
    if (e.key === "Escape") {
      setDraft(null);
      const t = e.currentTarget;
      requestAnimationFrame(() => t.blur());
    }
  };
  const cls = clsx(
    "max-w-full rounded-md bg-transparent px-1 -mx-1 outline-none transition-colors duration-150 [field-sizing:content] hover:bg-ink/[0.04] focus:bg-lilac-soft",
    className,
  );
  if (multiline)
    return (
      <textarea
        ref={area}
        rows={1}
        value={v}
        aria-label={label ?? placeholder}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={keys}
        className={clsx(cls, "block w-full resize-none overflow-hidden")}
      />
    );
  return (
    <input
      value={v}
      aria-label={label ?? placeholder}
      placeholder={placeholder}
      size={Math.max(3, Math.ceil((v.length || placeholder?.length || 4) * 1.1))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={keys}
      className={cls}
    />
  );
}
