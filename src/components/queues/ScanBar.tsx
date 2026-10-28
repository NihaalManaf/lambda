"use client";

import clsx from "clsx";
import type { ScanStatus } from "@/lib/queues/types";
import { Icon } from "@/components/viz/icons";

// scan button · done/total progress line · mono timestamp

const stamp = (iso?: string) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(+d) ? null : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

export const running = (s?: ScanStatus | null) => s?.state === "scanning" || s?.state === "normalizing";

export default function ScanBar({ status, scannedAt, onScan }: { status: ScanStatus | null; scannedAt?: string; onScan: () => void }) {
  const busy = running(status);
  const pct = status && status.total > 0 ? Math.min(1, status.done / status.total) : 0;
  const at = stamp(scannedAt);
  return (
    <div className="relative flex items-center gap-3 overflow-hidden rounded-full border border-line bg-card py-1.5 pl-1.5 pr-4">
      <button className="btn btn-primary !py-1.5 !pl-3 !pr-3.5 text-[13px]" disabled={busy} onClick={onScan}>
        <Icon name="retry" size={13} className={clsx(busy && "animate-spin [animation-duration:1.2s]")} />
        {busy ? (status?.state === "normalizing" ? "reading" : "scanning") : "scan"}
      </button>
      {busy && status && status.total > 0 && (
        <span className="font-mono text-[11px] tabular-nums text-ink-2">
          {status.done}/{status.total}
        </span>
      )}
      {status?.state === "error" && (
        <span className="inline-flex items-center gap-1 text-[12px] text-bad" title={status.error}>
          <Icon name="warn" size={13} /> failed
        </span>
      )}
      {at && <span className="ml-auto font-mono text-[11px] text-grey">{at}</span>}
      <span
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-[2px] origin-left bg-lilac transition-[transform,opacity] duration-500 ease-out"
        style={{ transform: `scaleX(${busy ? Math.max(0.03, pct) : 1})`, opacity: busy ? 1 : 0 }}
      />
    </div>
  );
}
