// Compare two models, table by table. Renames come from the ops (a rename is indistinguishable
// from drop+add by state alone).
import type { DiffState } from "../types";
import { UNKNOWN_TYPE, qualify, touchedTables } from "./apply";
import type { Column, SchemaModel, SchemaOp, Table } from "./types";

export interface ColDiff {
  name: string;
  from?: string;
  diff: DiffState;
  before?: { type?: string; required?: boolean; default?: string };
  enumValues?: { v: string; diff: DiffState }[];
}
export interface PartDiff { name: string; diff: DiffState }
export interface TableDiff {
  id: string;
  from?: string;
  diff: DiffState;
  cols: ColDiff[]; // after order, removed ones slotted where they were
  fks: PartDiff[];
  indexes: PartDiff[];
  checks: PartDiff[];
  size: number; // how much changed: drives ordering
}

export interface Renames { tables: Record<string, string>; cols: Record<string, Record<string, string>> }

// new name -> original name, chains followed (a→b→c gives c: a)
export function renamesOf(ops: SchemaOp[]): Renames {
  const tables: Record<string, string> = {};
  const cols: Record<string, Record<string, string>> = {};
  for (const op of ops) {
    if (op.op === "rename_table") {
      const from = qualify(op.table);
      const to = op.to.includes(".") ? op.to : `${from.slice(0, from.lastIndexOf("."))}.${op.to}`;
      tables[to] = tables[from] ?? from;
      delete tables[from];
      if (cols[from]) { cols[to] = cols[from]; delete cols[from]; }
    } else if (op.op === "rename_column") {
      const t = qualify(op.table);
      const m = (cols[t] ??= {});
      m[op.to] = m[op.column] ?? op.column;
      delete m[op.column];
    }
  }
  return { tables, cols };
}

export const enumOf = (t: Table | undefined, col: string) =>
  t?.checks.find((c) => c.allowed && c.cols.length === 1 && c.cols[0] === col)?.allowed;

function enumDiff(before?: string[], after?: string[]) {
  if (!before && !after) return undefined;
  const a = after ?? [];
  const b = before ?? [];
  const out = a.map((v) => ({ v, diff: (before && !b.includes(v) ? "added" : before ? "same" : "added") as DiffState }));
  for (const v of b) if (!a.includes(v)) out.push({ v, diff: "removed" });
  return out;
}

function colDiff(t: Table, bt: Table | undefined, c: Column, from: string | undefined, isNew: boolean): ColDiff {
  const name = from ?? c.name;
  const bc = bt?.columns.find((x) => x.name === name);
  const enumValues = enumDiff(bt && enumOf(bt, name), enumOf(t, c.name));
  if (isNew) return { name: c.name, diff: "added", ...(enumValues && { enumValues: enumValues.map((e) => ({ ...e, diff: "added" as DiffState })) }) };
  if (!bc) {
    // implicit stub column (type unknown): it existed already, we just learned of it
    return { name: c.name, diff: c.type === UNKNOWN_TYPE ? "same" : "added", ...(enumValues && { enumValues }) };
  }
  const before: ColDiff["before"] = {};
  if (bc.type !== c.type && bc.type !== UNKNOWN_TYPE) before.type = bc.type;
  if (bc.nullable !== c.nullable) before.required = !bc.nullable;
  if ((bc.default ?? "") !== (c.default ?? "")) before.default = bc.default ?? "";
  const enumChanged = enumValues?.some((e) => e.diff !== "same");
  const changed = Object.keys(before).length > 0 || enumChanged;
  return {
    name: c.name,
    ...(from && from !== c.name && { from }),
    diff: from && from !== c.name ? "renamed" : changed ? "changed" : "same",
    ...(Object.keys(before).length && { before }),
    ...(enumValues && { enumValues }),
  };
}

function parts<X extends { name: string }>(a: X[], b: X[] | undefined, isNew: boolean): PartDiff[] {
  const key = (x: X) => JSON.stringify(x);
  const out: PartDiff[] = a.map((x) => {
    const p = b?.find((y) => y.name === x.name);
    return { name: x.name, diff: isNew || !p ? "added" : key(p) === key(x) ? "same" : "changed" };
  });
  for (const y of b ?? []) if (!a.some((x) => x.name === y.name)) out.push({ name: y.name, diff: "removed" });
  return out;
}

export function tableDiff(before: SchemaModel, after: SchemaModel, id: string, r: Renames = { tables: {}, cols: {} }): TableDiff | null {
  const t = after.tables[id];
  if (!t) {
    const bt = before.tables[id];
    if (!bt) return null;
    const cols = bt.columns.map((c): ColDiff => ({ name: c.name, diff: "removed" }));
    return { id, diff: "removed", cols, fks: parts([], bt.fks, false), indexes: parts([], bt.indexes, false), checks: parts([], bt.checks, false), size: 100 + cols.length };
  }
  const from = r.tables[id];
  const bt = before.tables[from ?? id];
  // a stub that first shows up here pre-existed in the real db: it's changed, not new
  const isNew = !bt && t.origin === "migration";
  const crn = r.cols[id] ?? {};
  const cols = t.columns.map((c) => colDiff(t, bt, c, crn[c.name], isNew));
  if (bt) {
    const kept = new Set(t.columns.map((c) => crn[c.name] ?? c.name));
    bt.columns.forEach((c, i) => {
      if (kept.has(c.name)) return;
      cols.splice(Math.min(i, cols.length), 0, { name: c.name, diff: "removed" });
    });
  }
  const fks = parts(t.fks, bt?.fks, isNew);
  const indexes = parts(t.indexes, bt?.indexes, isNew);
  const checks = parts(t.checks, bt?.checks, isNew);
  const moved = [...cols, ...fks, ...indexes, ...checks].filter((x) => x.diff !== "same").length;
  const meta = bt ? Number(bt.rls !== t.rls) + Number(bt.policies.join() !== t.policies.join()) + Number(bt.triggers.join() !== t.triggers.join()) + Number(JSON.stringify(bt.uniques) !== JSON.stringify(t.uniques)) : 0;
  const diff: DiffState = isNew ? "added" : from && from !== id ? "renamed" : moved + meta > 0 ? "changed" : "same";
  return { id, ...(from && from !== id && { from }), diff, cols, fks, indexes, checks, size: (isNew ? 50 : 0) + moved + meta };
}

// per-table diffs for the touched tables (from ops), or every table that differs when no ops given
export function diff(before: SchemaModel, after: SchemaModel, ops?: SchemaOp[]): Record<string, TableDiff> {
  const r = renamesOf(ops ?? []);
  const ids = ops
    ? touchedTables(ops, before)
    : [...new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])].filter(
        (k) => JSON.stringify(before.tables[k]) !== JSON.stringify(after.tables[k]),
      );
  const out: Record<string, TableDiff> = {};
  for (const id of ids) {
    const d = tableDiff(before, after, id, r);
    if (d) out[id] = d;
  }
  return out;
}
