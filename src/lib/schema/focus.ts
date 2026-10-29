import "server-only";
import { z } from "zod";
import { featurePrompt, generate } from "../llm";
import { now } from "../store";
import type { FeatureView, SchemaFocus } from "../types";
import { bare } from "./apply";
import { toErd } from "./graph";
import { compact, relevantTables } from "./propose";
import type { Replayed } from "./replay";
import type { ErdGraph } from "./types";

// Understand mode: the tables an existing feature reads / writes today, drawn at head (no diff). The model
// picks from the real schema (names it can't see don't survive); a token match is the fallback.

const MAX = 12;
const Out = z.object({
  tables: z.array(z.object({ table: z.string(), role: z.string().describe("<= 12 words: what the feature does with it today") })),
});

export async function pickFocus(v: FeatureView, r: Replayed): Promise<SchemaFocus> {
  const all = Object.keys(r.head.tables).filter((t) => !bare(t).startsWith("_trash"));
  const byBare = new Map(all.map((t) => [bare(t), t]));
  const text = [v.title, v.brief, ...(v.briefDoc?.surfaces ?? []), ...v.stories.map((s) => `${s.want} ${s.soThat}`)].join("\n");
  const hint = relevantTables(r.head, text, 20);
  let tables: SchemaFocus["tables"] = [];
  try {
    const out = await generate({
      schema: Out,
      effort: "low",
      mode: "understand",
      system: `you map an existing feature onto its postgres tables. pick only tables the feature reads or writes today, at most ${MAX}, most central first. use exact names from the list.`,
      prompt: `${featurePrompt(v)}\n\nall tables:\n${all.map(bare).join(", ")}\n\nlikely matches with columns:\n${compact(r.head, hint) || "(none)"}`,
    });
    const seen = new Set<string>();
    for (const t of out.tables) {
      const id = r.head.tables[t.table] ? t.table : byBare.get(bare(t.table));
      if (id && !seen.has(id)) {
        seen.add(id);
        tables.push({ id, role: t.role.split(/\s+/).slice(0, 12).join(" ") });
      }
    }
  } catch {
    // no model / quota: the token match below still draws something
  }
  if (!tables.length) tables = hint.slice(0, MAX).map((id) => ({ id, role: "" }));
  return { tables: tables.slice(0, MAX), sig: r.sig, at: now() };
}

// the focus tables at head (no FK neighbours: `team` alone drags in 100+), and the migrations that touched each
export type FocusView = { graph: ErdGraph; history: Record<string, { id: string; title: string; date: string }[]>; stale: boolean };

export function focusView(r: Replayed, focus: SchemaFocus): FocusView {
  const ids = focus.tables.map((t) => t.id).filter((id) => r.head.tables[id]);
  const meta = new Map(r.metas.map((m) => [m.id, m]));
  return {
    graph: toErd(r.head, r.head, ids, [], [], { context: false }),
    // newest first, the last 8
    history: Object.fromEntries(
      ids.map((id) => [id, (r.history[id] ?? []).slice(-8).reverse().map((m) => ({ id: m, title: meta.get(m)?.title ?? m, date: meta.get(m)?.date ?? "" }))]),
    ),
    stale: focus.sig !== r.sig,
  };
}
