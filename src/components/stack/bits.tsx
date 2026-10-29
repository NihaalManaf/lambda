"use client";

import clsx from "clsx";
import type { StackRole as ServiceRole, StackServiceStatus as ServiceStatus } from "@/lib/types";

export const statusColor: Record<ServiceStatus, string> = {
  ready: "bg-ok",
  starting: "bg-warn",
  crashed: "bg-bad",
  error: "bg-bad",
  stopped: "bg-line-2",
};

export function Dot({ status, className }: { status: ServiceStatus; className?: string }) {
  return (
    <span className={clsx("relative inline-grid h-2 w-2 place-items-center", className)} aria-label={status === "ready" ? "running" : status}>
      {status === "starting" && (
        <span className="absolute h-2 w-2 animate-ping rounded-full bg-warn/60 [animation-duration:1.4s] motion-reduce:hidden" />
      )}
      <span className={clsx("relative h-1.5 w-1.5 rounded-full transition-colors duration-200", statusColor[status])} />
    </span>
  );
}

// tiny line icons, 14px, currentColor
export function RoleIcon({ role, className }: { role: ServiceRole; className?: string }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className={clsx("shrink-0", className)}>
      {role === "frontend" && (
        <>
          <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" {...p} />
          <path d="M1.5 5h11" {...p} />
        </>
      )}
      {role === "api" && <path d="M5 3 2.5 7 5 11M9 3l2.5 4L9 11" {...p} />}
      {role === "queue" && <path d="M2.5 4h9M2.5 7h9M2.5 10h6" {...p} />}
      {role === "worker" && (
        <>
          <circle cx="7" cy="7" r="2" {...p} />
          <path d="M7 1.5v2M7 10.5v2M1.5 7h2M10.5 7h2M3.1 3.1l1.4 1.4M9.5 9.5l1.4 1.4M3.1 10.9l1.4-1.4M9.5 4.5l1.4-1.4" {...p} />
        </>
      )}
      {role === "other" && <circle cx="7" cy="7" r="2.5" {...p} />}
    </svg>
  );
}

export const ROLES: ServiceRole[] = ["frontend", "api", "queue", "worker", "other"];
