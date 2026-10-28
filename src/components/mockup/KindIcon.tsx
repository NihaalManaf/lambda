import type { AnnotationKind } from "@/lib/types";
import { kindMeta } from "./marks";

// Tiny glyph per annotation kind, used in legend chips + the list.
export default function KindIcon({ kind, size = 14 }: { kind: AnnotationKind; size?: number }) {
  const c = kindMeta(kind).color;
  const s = { stroke: c, strokeWidth: 2, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      {kind === "insert" && (
        <>
          <rect x="1.5" y="1.5" width="13" height="13" rx="2" {...s} />
          <path d="M8 5v6M5 8h6" {...s} />
        </>
      )}
      {kind === "remove" && <path d="M3 3l10 10M13 3L3 13" {...s} />}
      {kind === "move" && <path d="M2 12c3-8 8-9 12-7M14 5l-3-2.5M14 5l-3.5 1.5" {...s} />}
      {kind === "change-text" && <path d="M2 8h12M5 12l3-3 3 3" {...s} />}
      {kind === "restyle" && <ellipse cx="8" cy="8" rx="6.5" ry="5" strokeDasharray="3 2.5" {...s} />}
      {kind === "note" && (
        <>
          <circle cx="8" cy="8" r="6.5" {...s} />
          <path d="M6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1M8 11.3v.2" {...s} />
        </>
      )}
    </svg>
  );
}
