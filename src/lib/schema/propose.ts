import "server-only";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { blanksToNull, featurePrompt, generate, type Nulls } from "../llm";
import { getSettings, id, now } from "../store";
import type { Feature } from "../types";
import { bare, qualify } from "./apply";
import { enumOf } from "./diff";
import { opsToSql } from "./emit";
import { shortType } from "./graph";
import { humanize } from "./humanize";
import { parseSql } from "./parse";
import { current } from "./replay";
import type { ColSpec, Fk, SchemaModel, SchemaOp, SchemaProposal } from "./types";

export { opsToSql };

// Proposals: what a feature would do to the schema, as ops (never SQL from the model).

const TYPES = ["uuid", "text", "int", "bigint", "boolean", "timestamptz", "date", "jsonb", "numeric", "text[]"] as const;
const LLM_OPS = [
  "add_table", "drop_table", "rename_table", "add_column", "drop_column", "rename_column", "alter_column", "add_fk", "add_check",
  "add_unique", "drop_constraint", "add_index", "drop_index", "set_enum", "rls", "add_policy", "add_trigger", "drop_trigger", "data",
] as const;
const ON_DELETE = ["CASCADE", "SET NULL", "SET DEFAULT", "RESTRICT"] as const;

// flat op shape. "" / [] = unset (structured output caps nullable params at 16); blanksToNull maps them back
const OPT_TYPES = ["", ...TYPES] as const;
const OPT_ON_DELETE = ["", ...ON_DELETE] as const;
const Col = z.object({
  name: z.string(),
  type: z.enum(TYPES),
  nullable: z.boolean().nullable(),
  default: z.string().describe("sql default expression, e.g. now(), 'draft', false; \"\" = none"),
  pk: z.boolean(),
  unique: z.boolean(),
  references: z.object({ table: z.string(), col: z.string(), onDelete: z.enum(OPT_ON_DELETE) }).nullable(),
});
const Op = z.object({
  op: z.enum(LLM_OPS),
  table: z.string(),
  name: z.string().describe("constraint/index/policy/trigger name"),
  column: z.string(),
  to: z.string().describe("new name for renames"),
  columns: z.array(Col).describe("add_table only"),
  col: Col.nullable().describe("add_column only"),
  type: z.enum(OPT_TYPES),
  nullable: z.boolean().nullable(),
  default: z.string(),
  cols: z.array(z.string()),
  refTable: z.string(),
  refCols: z.array(z.string()),
  onDelete: z.enum(OPT_ON_DELETE),
  values: z.array(z.string()).describe("set_enum / add_check allowed values"),
  unique: z.boolean(),
  on: z.boolean().nullable().describe("rls on/off"),
  kind: z.enum(["", "update", "insert", "delete"]).describe("data op only"),
  note: z.string().describe("data op: <= 8 words on the backfill"),
});
export const Out = z.object({ title: z.string().describe("<= 4 words"), ops: z.array(Op) });

const SYSTEM = `
you design postgres schema changes for a feature as a list of structured ops. never write sql.
- reuse existing tables/columns (listed as name(col:type, ...); * = pk, -> = fk, [a|b] = allowed values). add only what the feature needs.
- table names: schema-qualified only if not public. snake_case.
- column types only: ${TYPES.join(", ")}.
- enums are text columns + set_enum (allowed values). new required column on an existing table needs a default.
- prefer additive changes; drop/rename only when the brief demands it.
- data op (update/insert/delete) only for real backfills, with a note.
- fill only the fields the op uses; leave the rest "" / [] / false / null. 1-15 ops. title <= 4 words.
`.trim();

const words = (s: string, n: number) => s.trim().split(/\s+/).filter(Boolean).slice(0, n).join(" ");
const tokens = (s: string) => new Set((s.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).map((w) => w.replace(/s$/, "")));

// tables whose name tokens show up in the brief/stories/prompt, plus FK neighbours, <= 15
export function relevantTables(m: SchemaModel, text: string, max = 15): string[] {
  const want = tokens(text);
  const scored = Object.values(m.tables)
    .filter((t) => !bare(t.name).startsWith("_trash"))
    .map((t) => ({ id: t.name, score: bare(t.name).split(/[_.]/).filter((w) => want.has(w.replace(/s$/, ""))).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const out = scored.slice(0, 10).map((x) => x.id);
  for (const id of [...out]) {
    const t = m.tables[id];
    for (const f of t.fks) if (out.length < max && !out.includes(f.refTable)) out.push(f.refTable);
  }
  return out.slice(0, max);
}

export function compact(m: SchemaModel, ids: string[]): string {
  return ids
    .map((id) => {
      const t = m.tables[id];
      if (!t) return "";
      const fk = new Map(t.fks.map((f: Fk) => [f.cols[0], bare(f.refTable)]));
      const cols = t.columns.slice(0, 40).map((c) => {
        const e = enumOf(t, c.name);
        return `${c.name}${c.pk ? "*" : ""}:${shortType(c.type)}${fk.has(c.name) ? `->${fk.get(c.name)}` : ""}${e ? `[${e.join("|")}]` : ""}`;
      });
      return `${bare(id)}(${cols.join(", ")}${t.columns.length > 40 ? ", …" : ""})`;
    })
    .filter(Boolean)
    .join("\n");
}

export type RawOp = Nulls<z.infer<typeof Op>>;
type RawCol = z.infer<typeof Col> & { default: string | null };
const colSpec = (c: RawCol): ColSpec => ({
  name: c.name, type: c.type,
  ...(c.nullable != null && { nullable: c.nullable }), ...(c.default != null && { default: c.default }),
  ...(c.pk && { pk: true }), ...(c.unique && { unique: true }),
  ...(c.references && { references: { table: qualify(c.references.table), col: c.references.col, ...(c.references.onDelete && { onDelete: c.references.onDelete }) } }),
});

// model output -> SchemaOp, dropping anything missing the fields it needs
export function toOp(r: RawOp): SchemaOp | null {
  const table = r.table ? qualify(r.table) : "";
  const need = (...xs: unknown[]) => xs.every((x) => x != null && x !== "");
  switch (r.op) {
    case "add_table": return need(table, r.columns) ? { op: "add_table", table, columns: r.columns!.map(colSpec) } : null;
    case "drop_table": return need(table) ? { op: "drop_table", table } : null;
    case "rename_table": return need(table, r.to) ? { op: "rename_table", table, to: qualify(r.to!) } : null;
    case "add_column": return need(table, r.col) ? { op: "add_column", table, column: colSpec(r.col!) } : null;
    case "drop_column": return need(table, r.column) ? { op: "drop_column", table, column: r.column! } : null;
    case "rename_column": return need(table, r.column, r.to) ? { op: "rename_column", table, column: r.column!, to: r.to! } : null;
    case "alter_column":
      return need(table, r.column)
        ? { op: "alter_column", table, column: r.column!, ...(r.type && { type: r.type }), ...(r.nullable != null && { nullable: r.nullable }), ...(r.default != null && { default: r.default }) }
        : null;
    case "add_fk":
      return need(table, r.cols?.length, r.refTable)
        ? { op: "add_fk", table, ...(r.name && { name: r.name }), cols: r.cols!, refTable: qualify(r.refTable!), refCols: r.refCols ?? ["id"], ...(r.onDelete && { onDelete: r.onDelete }) }
        : null;
    case "add_check": return need(table, r.cols?.length) ? { op: "add_check", table, ...(r.name && { name: r.name }), cols: r.cols!, ...(r.values && { allowed: r.values }) } : null;
    case "add_unique": return need(table, r.cols?.length) ? { op: "add_unique", table, ...(r.name && { name: r.name }), cols: r.cols! } : null;
    case "drop_constraint": return need(table, r.name) ? { op: "drop_constraint", table, name: r.name! } : null;
    case "add_index": return need(table, r.cols?.length) ? { op: "add_index", table, ...(r.name && { name: r.name }), cols: r.cols!, ...(r.unique && { unique: true }) } : null;
    case "drop_index": return need(r.name) ? { op: "drop_index", name: r.name! } : null;
    case "set_enum": return need(table, r.column, r.values?.length) ? { op: "set_enum", table, column: r.column!, values: r.values! } : null;
    case "rls": return need(table) ? { op: "rls", table, on: r.on ?? true } : null;
    case "add_policy": return need(table, r.name) ? { op: "add_policy", table, name: r.name! } : null;
    case "add_trigger": return need(table, r.name) ? { op: "add_trigger", table, name: r.name! } : null;
    case "drop_trigger": return need(table, r.name) ? { op: "drop_trigger", table, name: r.name! } : null;
    case "data": return need(table) ? { op: "data", table, kind: r.kind || "update" } : null;
  }
  return null;
}

export async function proposeFromPrompt(feature: Feature, text: string): Promise<SchemaProposal> {
  const r = await current();
  const stories = feature.stories.map((s) => `${s.want} ${s.soThat}`).join("\n");
  const ids = relevantTables(r.head, `${feature.title}\n${feature.brief}\n${stories}\n${text}`);
  const out = await generate({
    schema: Out,
    system: SYSTEM,
    effort: "medium",
    prompt: `${featurePrompt(feature)}\n\nschema change asked for:\n${text}\n\nexisting tables:\n${compact(r.head, ids) || "(none matched)"}`,
  });
  const ops = out.ops.map((o) => toOp(blanksToNull(o))).filter((o): o is SchemaOp => !!o);
  if (!ops.length) throw new Error("model proposed no usable ops");
  return { id: id("sp"), source: "llm", title: words(out.title, 4) || "schema change", prompt: text, ops, baseSig: r.sig, createdAt: now() };
}

export async function proposeFromSql(sql: string, name?: string): Promise<SchemaProposal> {
  const res = await parseSql(sql);
  if (res.error) throw new Error(`sql line ${res.error.line}: ${res.error.message}`);
  if (!res.ops.length) throw new Error("no schema changes in that sql");
  const r = await current();
  return { id: id("sp"), source: "sql", title: name ? humanize(name) : "pasted sql", ops: res.ops, sql, baseSig: r.sig, createdAt: now() };
}

export async function proposeFromGit(files: string[]): Promise<SchemaProposal> {
  const { repoPath } = getSettings();
  const root = path.resolve(repoPath);
  const ops: SchemaOp[] = [];
  const parts: string[] = [];
  for (const f of files.slice(0, 20)) {
    const abs = path.resolve(root, f);
    if (!abs.startsWith(root + path.sep) || !abs.endsWith(".sql")) throw new Error(`not a repo .sql file: ${f}`);
    const sql = fs.readFileSync(abs, "utf8");
    const res = await parseSql(sql);
    if (res.error) throw new Error(`${path.basename(f)} line ${res.error.line}: ${res.error.message}`);
    ops.push(...res.ops);
    parts.push(`-- ${f}\n${sql.trim()}`);
  }
  if (!parts.length) throw new Error("no files picked");
  const r = await current();
  return {
    id: id("sp"), source: "git", title: files.length === 1 ? humanize(files[0]) : `${files.length} migrations`,
    ops, sql: parts.join("\n\n") + "\n", files: files.slice(0, 20), baseSig: r.sig, createdAt: now(),
  };
}
