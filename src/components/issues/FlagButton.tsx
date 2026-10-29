"use client";

import { createContext, useContext, useState } from "react";
import clsx from "clsx";
import { featureMode, type FeatureView, type IssueKind, type IssueRef } from "@/lib/types";
import { flagIssue } from "./api";

type FlagFeature = Pick<FeatureView, "id" | "mode" | "pieceId" | "issues">;
// the workspace provides the selected piece's view, so flags deep in a tab need no props threaded down
export const FlagFeatureCtx = createContext<FlagFeature | null>(null);

// A quiet "flag" on an artifact (story, flow node / edge case, mockup mark, schema table, failed run):
// logs an issue pointing at it. Understand mode only — renders nothing in build (or outside a workspace).
export default function FlagButton({
  feature: given,
  refTo,
  title,
  detail,
  kind = "bug",
  source = "pin",
  label = "flag",
  className,
}: {
  feature?: FlagFeature;
  refTo: IssueRef;
  title: string;
  detail?: string;
  kind?: IssueKind;
  source?: "pin" | "verify";
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const ctx = useContext(FlagFeatureCtx);
  const feature = given ?? ctx;
  if (!feature || featureMode(feature) !== "understand") return null;
  const f = feature;
  const flagged = state === "done" || (f.issues ?? []).some((i) => i.status === "open" && i.ref?.id === refTo.id);

  async function flag(e: React.MouseEvent) {
    e.stopPropagation();
    if (flagged || state === "busy") return;
    setState("busy");
    try {
      await flagIssue(f.id, { title, detail, kind, ref: refTo, pieceId: f.pieceId || undefined, source });
      setState("done");
    } catch {
      setState("error");
    }
  }

  return (
    <button
      type="button"
      onClick={flag}
      disabled={state === "busy"}
      title={flagged ? "in issues" : state === "error" ? "couldn't flag — try again" : `log "${title}" as an issue`}
      className={clsx(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[10.5px] transition-[color,background-color,transform] duration-150 active:scale-[0.96]",
        flagged ? "text-warn" : state === "error" ? "text-bad" : "text-grey/70 hover:bg-paper-2 hover:text-ink",
        className,
      )}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        <path d="M2 9.5V1M2 1.5h5.5l-1 2 1 2H2" stroke="currentColor" strokeWidth="1.2" fill={flagged ? "currentColor" : "none"} strokeLinejoin="round" />
      </svg>
      {flagged ? "flagged" : state === "busy" ? "…" : label}
    </button>
  );
}
