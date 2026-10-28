import type { DiffState } from "@/lib/types";

// One colour language for every diff: schema rows, tables, fk edges, queue nodes and edges.

export interface DiffLook {
  bar: string;
  bg: string;
  text: string;
  border: string;
  strike?: boolean;
  opacity?: number;
  dashed?: boolean;
}

const tint = (v: string, pct: number) => `color-mix(in srgb, var(${v}) ${pct}%, transparent)`;

export const DIFF: Record<DiffState, DiffLook> = {
  added: { bar: "var(--ok)", bg: tint("--ok", 8), text: "var(--ok)", border: "var(--ok)" },
  removed: { bar: "var(--bad)", bg: tint("--bad", 8), text: "var(--bad)", border: "var(--bad)", strike: true },
  changed: { bar: "var(--warn)", bg: tint("--warn", 10), text: "var(--warn)", border: "var(--warn)" },
  renamed: { bar: "var(--blue)", bg: tint("--blue", 8), text: "var(--blue)", border: "var(--blue)" },
  same: { bar: "var(--line-2)", bg: "var(--card)", text: "var(--ink)", border: "var(--ink)" },
  context: { bar: "var(--line-2)", bg: "var(--paper)", text: "var(--grey)", border: "var(--line-2)", opacity: 0.5, dashed: true },
};

/** stroke colour for an edge in this state ("same" edges are plain ink) */
export const edgeStroke = (d: DiffState) => (d === "same" ? "var(--ink)" : d === "context" ? "var(--line-2)" : DIFF[d].bar);
