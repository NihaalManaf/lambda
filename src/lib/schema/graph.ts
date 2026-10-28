// Models + diff -> a small ERD (<= 8 tables) the UI only has to draw.
import type { Badge, DiffState, IconName, Risk } from "../types";
import { UNKNOWN_TYPE, bare, qualify } from "./apply";
import { type ColDiff, type TableDiff, enumOf, renamesOf, tableDiff } from "./diff";
import type { ErdCol, ErdEdge, ErdGraph, ErdTable, MigrationView, SchemaModel, SchemaOp, Table } from "./types";

export const MAX_ERD_TABLES = 8;

export function shortType(t: string): string {
  if (t === UNKNOWN_TYPE) return "?";
  const arr = t.endsWith("[]");
  const b = t.replace(/\[\]$/, "").replace(/^pg_catalog\./, "").toLowerCase();
  const s =
    /^(int|int2|int4|int8|smallint|integer|bigint|serial|bigserial)$/.test(b) ? "int"
    : /^timestamp/.test(b) ? "time"
    : /^(varchar|character varying|citext|char|bpchar|text|name)$/.test(b) ? "text"
    : /^jsonb?$/.test(b) ? "json"
    : /^(numeric|decimal|float\d?|real|double precision|money)$/.test(b) ? "num"
    : /^bool(ean)?$/.test(b) ? "bool"
    : b;
  return arr ? `${s}[]` : s;
}

// tables at FK distance 1, both directions
function neighbours(m: SchemaModel, id: string): string[] {
  const t = m.tables[id];
  const out = new Set(t ? t.fks.map((f) => f.refTable) : []);
  for (const o of Object.values(m.tables)) if (o.fks.some((f) => f.refTable === id)) out.add(o.name);
  out.delete(id);
  return [...out];
}
const fkCount = (m: SchemaModel, id: string) =>
  (m.tables[id]?.fks.length ?? 0) + Object.values(m.tables).filter((o) => o.fks.some((f) => f.refTable === id)).length;

function badges(t: Table, ops: SchemaOp[]): Badge[] {
  const out: Badge[] = [];
  if (t.rls) out.push({ icon: "lock", tone: "ok", title: `row security on${t.policies.length ? "" : ", no policy"}` });
  const data = ops.filter((o) => o.op === "data" && qualify(o.table) === t.name).length;
  if (data) out.push({ icon: "bucket", text: String(data), tone: "warn", title: "data rewritten here" });
  if (t.triggers.length) out.push({ icon: "bolt", text: String(t.triggers.length), title: "triggers fire on writes" });
  if (t.origin === "stub") out.push({ icon: "eye", text: "partial", tone: "muted", title: "columns before migrations unknown" });
  return out;
}

function erdCols(t: Table, d: TableDiff | null, keep?: Set<string>, prev?: Table): ErdCol[] {
  const fkCols = new Set(t.fks.flatMap((f) => f.cols));
  const uniq = new Set([...t.uniques, ...t.indexes.filter((i) => i.unique)].filter((u) => u.cols.length === 1).map((u) => u.cols[0]));
  const indexed = new Set(t.indexes.map((i) => i.cols[0]));
  const byName = new Map(t.columns.map((c) => [c.name, c]));
  const prevBy = new Map((prev?.columns ?? []).map((c) => [c.name, c]));
  const rows: ColDiff[] = d ? d.cols : t.columns.map((c) => ({ name: c.name, diff: "same" }));
  const out: ErdCol[] = [];
  for (const r of rows) {
    if (keep && !keep.has(r.name)) continue;
    const c = byName.get(r.name) ?? prevBy.get(r.name);
    if (!c) continue;
    const removed = r.diff === "removed";
    const pk = !!c.pk;
    const fk = !removed && fkCols.has(c.name);
        const evals = r.enumValues ?? (removed ? undefined : enumOf(t, c.name)?.map((v) => ({ v, diff: "same" as DiffState })));
    out.push({
      name: c.name,
      ...(r.from && { from: r.from }),
      type: shortType(c.type),
      fullType: c.type,
      required: !c.nullable,
      pk, fk,
      unique: !removed && uniq.has(c.name),
      indexed: !removed && indexed.has(c.name),
      diff: keep ? "same" : r.diff,
      ...(r.before && { before: r.before }),
      ...(evals && { enumValues: evals }),
      ...(c.comment && { comment: c.comment }),
      pinned: !keep && r.diff !== "same" ? true : pk || fk,
    });
  }
  return out;
}

// FK neighbours that matter to this change: every link of an added/removed/renamed table,
// only the links through changed columns or fks of a changed one
function linked(before: SchemaModel, after: SchemaModel, d: TableDiff): string[] {
  if (d.diff !== "changed") return neighbours(after.tables[d.id] ? after : before, d.id);
  const hot = new Set(d.cols.filter((c) => c.diff !== "same").map((c) => c.name));
  const hotFk = new Set(d.fks.filter((f) => f.diff !== "same").map((f) => f.name));
  const out = new Set<string>();
  for (const m of [after, before]) {
    for (const f of m.tables[d.id]?.fks ?? []) if (hotFk.has(f.name) || f.cols.some((c) => hot.has(c))) out.add(f.refTable);
    for (const o of Object.values(m.tables)) if (o.fks.some((f) => f.refTable === d.id && f.refCols.some((c) => hot.has(c)))) out.add(o.name);
  }
  out.delete(d.id);
  return [...out];
}
// with one changed table the change itself must stay big: at most this many context tables
const SOLO_CTX = 3;

// touched tables first (by change size), then the FK neighbours the change runs through as faded context, capped at 8
export function toErd(before: SchemaModel, after: SchemaModel, touched: string[], risks: Risk[], ops: SchemaOp[] = []): ErdGraph {
  const r = renamesOf(ops);
  const diffs = new Map<string, TableDiff>();
  for (const id of touched) {
    const d = tableDiff(before, after, id, r);
    if (d) diffs.set(id, d);
  }
  const main = [...diffs.values()].sort((a, b) => b.size - a.size).map((d) => d.id);
  const ctx = new Set<string>();
  const exists = (n: string) => !diffs.has(n) && !!(after.tables[n] || before.tables[n]);
  for (const id of main) for (const n of linked(before, after, diffs.get(id)!)) if (exists(n)) ctx.add(n);
  const rest = new Set<string>();
  for (const id of main) for (const n of neighbours(after.tables[id] ? after : before, id)) if (exists(n) && !ctx.has(n)) rest.add(n);
  const byFks = (xs: Iterable<string>) => [...xs].sort((a, b) => fkCount(after, b) - fkCount(after, a));
  const ctxIds = byFks(ctx);
  const room = Math.max(0, Math.min(MAX_ERD_TABLES - main.length, main.length === 1 && diffs.get(main[0])!.diff !== "same" ? SOLO_CTX : MAX_ERD_TABLES));
  const shown = [...main.slice(0, MAX_ERD_TABLES), ...ctxIds.slice(0, room)];
  const overflow = [...main.slice(MAX_ERD_TABLES), ...ctxIds.slice(room), ...byFks(rest)];
  const on = new Set(shown);

  // edges: fks between shown tables (removed fks drawn from the before model)
  const edges: ErdEdge[] = [];
  const inv = Object.fromEntries(Object.entries(r.tables).map(([n, o]) => [o, n])); // old name -> new
  const keys = new Map<string, Set<string>>();
  const key = (t: string, c: string) => (keys.get(t) ?? keys.set(t, new Set()).get(t)!).add(c);
  for (const id of shown) {
    const t = after.tables[id] ?? before.tables[id];
    const d = diffs.get(id);
    const gone = !after.tables[id];
    const bt = before.tables[d?.from ?? id];
    const fks = [...t.fks.map((f) => ({ f, removed: gone })), ...(!gone && bt ? bt.fks.filter((f) => !t.fks.some((x) => x.name === f.name)).map((f) => ({ f, removed: true })) : [])];
    for (const { f, removed } of fks) {
      const to = inv[f.refTable] ?? f.refTable;
      if (!on.has(to)) continue;
      const fd = d?.fks.find((x) => x.name === f.name)?.diff;
      const ed: DiffState = removed ? "removed" : fd && fd !== "same" ? fd : diffs.has(id) && diffs.has(to) ? "same" : "context";
      const toCol = f.refCols[0] ?? "id";
      edges.push({ id: `${id}:${f.name}`, from: id, fromCol: f.cols[0], to, toCol, diff: ed, cascade: f.onDelete === "CASCADE" });
      key(id, f.cols[0]);
      key(to, toCol);
    }
  }

  const tables: ErdTable[] = shown.map((id) => {
    const d = diffs.get(id);
    const t = after.tables[id] ?? before.tables[id];
    const prev = before.tables[d?.from ?? id];
    const isCtx = !d;
    const keep = isCtx ? new Set([...(keys.get(id) ?? []), ...t.columns.filter((c) => c.pk).map((c) => c.name)]) : undefined;
    return {
      id,
      label: bare(id),
      ...(d?.from && { from: bare(d.from) }),
      diff: d?.diff ?? "context",
      origin: t.origin,
      rls: t.rls,
      badges: badges(t, ops),
      cols: erdCols(t, isCtx ? null : d!, keep, prev),
      riskIds: risks.filter((x) => x.target.id === id).map((x) => x.id),
    };
  });
  return { tables, edges, overflow, risks };
}

// grouped by table: {table: "template", text: "+ allow_smoothing"}; the rail shows the table once and
// only the part that differs per row (<=4 words). Big column runs fold into a count.
export function opsSummary(ops: SchemaOp[]): MigrationView["opsSummary"] {
  const rows: MigrationView["opsSummary"] = [];
  const perTable = new Map<string, number>();
  for (const o of ops) if (o.op === "add_column" || o.op === "drop_column") perTable.set(`${o.op}|${qualify(o.table)}`, (perTable.get(`${o.op}|${qualify(o.table)}`) ?? 0) + 1);
  const folded = new Set<string>();
  for (const o of ops) {
    const t = "table" in o ? bare(qualify(o.table)) : "";
    const row = (icon: IconName, text: string, diff: DiffState, table = t) => {
      if (!rows.some((r) => r.text === text && r.table === table)) rows.push({ icon, text, diff, ...(table && { table }) });
    };
    switch (o.op) {
      case "add_table": row("file", "+ table", "added"); break;
      case "drop_table": row("file", "− table", "removed"); break;
      case "rename_table": row("file", `→ ${bare(o.to)}`, "renamed"); break;
      case "add_column":
      case "drop_column": {
        const k = `${o.op}|${qualify(o.table)}`;
        const n = perTable.get(k)!;
        const add = o.op === "add_column";
        if (n > 2) { if (!folded.has(k)) { folded.add(k); row("file", `${add ? "+" : "−"} ${n} columns`, add ? "added" : "removed"); } }
        else row("file", `${add ? "+" : "−"} ${add ? o.column.name : o.column}`, add ? "added" : "removed");
        break;
      }
      case "rename_column": row("file", `${o.column} → ${o.to}`, "renamed"); break;
      case "alter_column":
        if (o.type) row("warn", `${o.column} → ${shortType(o.type)}`, "changed");
        if (o.nullable !== undefined) row("key", `${o.column} ${o.nullable ? "optional" : "required"}`, "changed");
        if (o.default !== undefined) row("file", `${o.column} default`, "changed");
        break;
      case "add_fk": row("link", `→ ${bare(qualify(o.refTable))}`, "added"); break;
      case "add_check": if (o.allowed) row("split", `${o.cols[0]} values`, "changed"); break;
      case "set_enum": row("split", `${o.column} values`, "changed"); break;
      case "add_unique": row(o.name?.endsWith("_pkey") ? "key" : "index", o.name?.endsWith("_pkey") ? "+ primary key" : "+ unique", "added"); break;
      case "add_index": row("index", "+ index", "added"); break;
      case "drop_index": row("index", `− ${bare(o.name)}`, "removed", "indexes"); break;
      case "rename_index": row("index", `→ ${o.to}`, "renamed", "indexes"); break;
      case "rename_constraint": row("key", `→ ${o.to}`, "renamed"); break;
      case "rls": row("lock", o.on ? "lock rows" : "unlock rows", "changed"); break;
      case "add_policy": row("shield", "+ policy", "added"); break;
      case "drop_policy": row("shield", "− policy", "removed"); break;
      case "rename_policy": row("shield", `→ ${o.to}`, "renamed"); break;
      case "add_trigger": row("bolt", "+ trigger", "added"); break;
      case "drop_trigger": row("bolt", "− trigger", "removed"); break;
      case "view": row("eye", `${o.drop ? "−" : "+"} ${bare(o.name)}`, o.drop ? "removed" : "added", "views"); break;
      case "function": row("code", `${o.drop ? "−" : "+"} ${bare(o.name)}`, o.drop ? "removed" : "added", "functions"); break;
      case "data": row("bucket", `${o.kind} rows`, "changed"); break;
      case "dynamic": row("code", "dynamic sql", "context"); break;
      case "guard": row("shield", "safety check", "same"); break;
    }
  }
  return rows;
}
