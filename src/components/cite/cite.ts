"use client";

import { useEffect } from "react";
import type { ChangeNote } from "@/lib/ops";

// ⌥-click anything in a visualization to cite it in the ask bar. A cite travels in the message as a token the
// model can act on — `@{kind:id|label}` (flow nodes: `@{node:chart/node|label}`), ids as in the chat snapshot —
// and renders as a chip that jumps back to the object. In the composer it shows as `@label`, expanded on send.
// lambda answers with the same tokens (chat prompt), so the flows / stories it mentions open in one click.

export type CiteKind = "story" | "chart" | "node" | "case" | "table" | "mark";
const SCOPED: CiteKind[] = ["node", "case"]; // ids unique per chart: `chart/id`
export type Cite = { kind: CiteKind; id: string; scope?: string; label: string };

const clip = (s: string, n = 48) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
// labels live inside the token: keep its delimiters out
const safe = (s: string) => clip(s).replace(/[{}|]/g, "");

export const encode = (c: Cite) => `@{${c.kind}:${c.scope ? `${c.scope}/` : ""}${c.id}|${safe(c.label)}}`;
export const short = (c: Cite) => `@${safe(c.label)}`;

const TOKEN = /@\{(story|chart|node|case|table|mark):([^|{}]+)\|([^{}]*)\}/g;
export type Segment = string | Cite;
export function parse(text: string): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    const [kind, ref, label] = [m[1] as CiteKind, m[2], m[3]];
    const slash = SCOPED.includes(kind) ? ref.indexOf("/") : -1;
    out.push(slash > 0 ? { kind, scope: ref.slice(0, slash), id: ref.slice(slash + 1), label } : { kind, id: ref, label });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

// where a chip jumps back to (tables and sketch marks have no workspace focus target yet)
export function focusNote(c: Cite): ChangeNote | null {
  if (c.kind === "story") return { sign: "~", what: "story", label: c.label, tab: "stories", ref: c.id };
  if (c.kind === "chart") return { sign: "~", what: "chart", label: c.label, tab: "flows", ref: c.id };
  if (c.kind === "node") return { sign: "~", what: "node", label: c.label, tab: "flows", ref: c.id, scope: c.scope };
  if (c.kind === "case") return { sign: "~", what: "edge case", label: c.label, tab: "flows", ref: c.id, scope: c.scope };
  return null;
}

// a token still streaming in (`@{chart:fc_1|sync…` without its `}`) shouldn't flash as raw text
export const hidePartial = (text: string) => text.replace(/@\{[^{}]*$/, "");

// ---------- what can be cited, read off the dom the visualizations already render ----------

// a flow chart's card is #chart-<id>; its collapsible body (#chart-body-<id>) isn't
const CHART = '[id^="chart-"]:not([id^="chart-body-"])';
const CITABLE = [
  "[data-cite-kind]",
  "[data-story]",
  `${CHART} .react-flow__node[data-id]`,
  "[data-erd] .react-flow__node[data-id]",
].join(",");

export function resolve(target: EventTarget | null): Cite | null {
  const el = (target as Element | null)?.closest?.(CITABLE) as HTMLElement | null;
  if (!el) return null;
  const d = el.dataset;
  if (d.citeKind && d.citeId) return { kind: d.citeKind as CiteKind, id: d.citeId, scope: d.citeScope, label: d.citeLabel ?? d.citeId };
  if (d.story) {
    const named = el.matches("[aria-label]") ? el : el.querySelector("[aria-label^='story: ']");
    const label = named?.getAttribute("aria-label")?.replace(/^story: /, "") ?? el.textContent ?? d.story;
    return { kind: "story", id: d.story, label };
  }
  if (d.id) {
    const chart = el.closest(CHART);
    if (chart) {
      // the node's own label, not its badges (edge-case counts, glyphs)
      const label = el.querySelector("[data-label]")?.textContent || el.textContent || d.id;
      return { kind: "node", id: d.id, scope: chart.id.slice("chart-".length), label };
    }
    return { kind: "table", id: d.id, label: d.id };
  }
  return null;
}

// ⌥ held → citable things outline in lilac; ⌥-click → "lambda:cite" {cite}. Mounted once by the ask bar.
const CSS = `
html[data-citing] :is(${CITABLE}) { cursor: copy; }
html[data-citing] :is(${CITABLE}):hover { outline: 2px solid var(--lilac); outline-offset: 3px; border-radius: 12px; }
`;
export const citeCss = CSS;

export function useCiteMode() {
  useEffect(() => {
    const root = document.documentElement;
    const set = (on: boolean) => (on ? root.setAttribute("data-citing", "") : root.removeAttribute("data-citing"));
    const key = (e: KeyboardEvent) => set(e.altKey);
    const blur = () => set(false);
    // capture phase: beat drag starts, selection, the ask bar's click-outside fold and the object's own click
    const down = (e: PointerEvent) => {
      if (!e.altKey || !resolve(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const click = (e: MouseEvent) => {
      if (!e.altKey) return;
      const cite = resolve(e.target);
      if (!cite) return;
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent<Cite>("lambda:cite", { detail: cite }));
    };
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    window.addEventListener("blur", blur);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("click", click, true);
    return () => {
      set(false);
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      window.removeEventListener("blur", blur);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("click", click, true);
    };
  }, []);
}
