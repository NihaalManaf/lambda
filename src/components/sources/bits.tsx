"use client";
import type { ReactNode } from "react";
import clsx from "clsx";
import type { ContextRef } from "@/lib/types";

// Small shared visual atoms for source rows + context cards.

const KIND: Record<ContextRef["kind"], { glyph: string; cls: string; label: string }> = {
  session: { glyph: ">_", cls: "bg-ink text-paper", label: "session" },
  linear: { glyph: "◐", cls: "bg-blue text-white", label: "linear" },
  slack: { glyph: "#", cls: "bg-lilac text-ink", label: "slack" },
  note: { glyph: "✎", cls: "bg-paper-2 text-ink border border-line-2", label: "note" },
};

export function KindIcon({ kind, size = 28 }: { kind: ContextRef["kind"]; size?: number }) {
  const k = KIND[kind];
  return (
    <span
      aria-label={k.label}
      className={clsx("inline-grid shrink-0 place-items-center rounded-full font-mono font-bold", k.cls)}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {k.glyph}
    </span>
  );
}

export const kindLabel = (k: ContextRef["kind"]) => KIND[k].label;

export function StatusDot({ ok, loading }: { ok: boolean; loading?: boolean }) {
  return (
    <span className="relative inline-flex h-2 w-2">
      {loading && <span className="absolute inset-0 animate-ping rounded-full bg-grey/40" />}
      <span className={clsx("relative h-2 w-2 rounded-full", loading ? "bg-grey" : ok ? "bg-ok" : "bg-bad")} />
    </span>
  );
}

export function SearchInput({ value, onChange, placeholder, autoFocus }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-grey">⌕</span>
      <input
        data-find
        className="input !py-2 !pl-8 text-[13px]"
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="shimmer h-11 rounded-xl" style={{ opacity: 1 - i * 0.18 }} />
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-8 text-center font-mono text-xs text-grey">{children}</div>;
}

// One compact source row: icon · title/meta · trailing action
export function Row({ kind, title, meta, action, onClick, active }: {
  kind: ContextRef["kind"];
  title: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <div
      onClick={onClick}
      className={clsx(
        "group flex items-center gap-3 rounded-xl px-2.5 py-2 transition-colors",
        onClick && "cursor-pointer",
        active ? "bg-paper-2" : "hover:bg-paper-2/70",
      )}
    >
      <KindIcon kind={kind} size={24} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] leading-snug text-ink">{title}</div>
        {meta && <div className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[11px] text-grey">{meta}</div>}
      </div>
      {action}
    </div>
  );
}

export function AddButton({ done, onClick }: { done?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={done ? "attached" : "attach"}
      disabled={done}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={clsx(
        "grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm transition-all duration-150 active:scale-90",
        done ? "bg-ok text-white" : "border border-line-2 bg-card text-ink hover:border-ink hover:bg-ink hover:text-paper",
      )}
    >
      {done ? "✓" : "+"}
    </button>
  );
}
