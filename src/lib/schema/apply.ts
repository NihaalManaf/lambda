// Fold SchemaOps into a SchemaModel. Pure, mutates the model it's given.
import type { ColSpec, Column, SchemaModel, SchemaOp, Table } from "./types";

export const UNKNOWN_TYPE = "?"; // a column we only know exists because a later migration touched it

export const qualify = (t: string) => (t.includes(".") ? t : `public.${t}`);
export const bare = (t: string) => t.replace(/^public\./, "");
const local = (t: string) => t.slice(t.lastIndexOf(".") + 1);

export function newTable(name: string, origin: Table["origin"], createdIn?: string): Table {
  return { name, columns: [], fks: [], checks: [], uniques: [], indexes: [], rls: false, policies: [], triggers: [], origin, ...(createdIn && { createdIn }) };
}

export function emptyModel(): SchemaModel {
  const users = newTable("auth.users", "baseline");
  users.columns.push({ name: "id", type: "uuid", nullable: false, pk: true });
  return { tables: { "auth.users": users }, views: [], functions: [] };
}

// unknown tables become stubs carrying whatever columns later migrations mention
function ensure(m: SchemaModel, name: string): Table {
  return (m.tables[name] ??= newTable(name, "stub"));
}
function ensureCol(t: Table, name: string, type = UNKNOWN_TYPE): Column {
  let c = t.columns.find((x) => x.name === name);
  if (!c) t.columns.push((c = { name, type, nullable: true }));
  return c;
}

const constraintNames = (t: Table) => new Set([...t.fks, ...t.checks, ...t.uniques].map((x) => x.name));
// Postgres default names: {t}_{col}_{suffix}, numbered on collision
function autoName(t: Table, cols: string[], suffix: string, taken = constraintNames(t)) {
  const base = [local(t.name), ...cols.slice(0, suffix === "check" ? 1 : cols.length)].join("_") + `_${suffix}`;
  let n = base;
  for (let i = 1; taken.has(n); i++) n = `${base}${i}`;
  return n;
}

const toColumn = (c: ColSpec): Column => ({
  name: c.name, type: c.type, nullable: c.pk ? false : (c.nullable ?? true),
  ...(c.default !== undefined && { default: c.default }), ...(c.pk && { pk: true }),
});

// set_enum is sugar: drop the column's existing IN-list check, add a fresh one
export function expandSetEnum(m: SchemaModel, op: Extract<SchemaOp, { op: "set_enum" }>): SchemaOp[] {
  const table = qualify(op.table);
  const t = m.tables[table];
  const old = t?.checks.filter((c) => c.allowed && c.cols.length === 1 && c.cols[0] === op.column) ?? [];
  const name = old[0]?.name ?? `${local(table)}_${op.column}_check`;
  return [
    ...old.map((c): SchemaOp => ({ op: "drop_constraint", table, name: c.name })),
    { op: "add_check", table, name, cols: [op.column], allowed: op.values },
  ];
}

function addFk(m: SchemaModel, t: Table, op: Extract<SchemaOp, { op: "add_fk" }>) {
  const refTable = qualify(op.refTable);
  const ref = ensure(m, refTable);
  const refCols = op.refCols.length ? op.refCols : ["id"];
  for (const c of refCols) {
    const col = ensureCol(ref, c);
    if (ref.origin === "stub" && c === "id" && col.type === UNKNOWN_TYPE) Object.assign(col, { pk: true, nullable: false });
  }
  op.cols.forEach((c) => ensureCol(t, c));
  const name = op.name ?? autoName(t, op.cols, "fkey");
  t.fks = t.fks.filter((f) => f.name !== name);
  t.fks.push({ name, cols: op.cols, refTable, refCols, ...(op.onDelete && { onDelete: op.onDelete }) });
}

function renameColumn(m: SchemaModel, t: Table, from: string, to: string) {
  const swap = (cols: string[]) => cols.map((c) => (c === from ? to : c));
  const c = t.columns.find((x) => x.name === from);
  if (c) c.name = to;
  else ensureCol(t, to);
  for (const x of [...t.fks, ...t.checks, ...t.uniques, ...t.indexes]) x.cols = swap(x.cols);
  for (const o of Object.values(m.tables)) for (const f of o.fks) if (f.refTable === t.name) f.refCols = swap(f.refCols);
}

export function applyOp(m: SchemaModel, op: SchemaOp, migId?: string) {
  const tableOf = () => ensure(m, qualify((op as { table: string }).table));
  switch (op.op) {
    case "add_table": {
      const name = qualify(op.table);
      const prev = m.tables[name];
      let t: Table;
      if (prev && op.ifNotExists) {
        t = prev; // no-op in postgres; for stubs it's the best evidence of the real columns
        for (const c of op.columns) if (!t.columns.some((x) => x.name === c.name)) t.columns.push(toColumn(c));
      } else {
        t = m.tables[name] = newTable(name, "migration", migId);
        t.columns = op.columns.map(toColumn);
      }
      for (const c of op.columns) {
        if (c.references) addFk(m, t, { op: "add_fk", table: name, cols: [c.name], refTable: c.references.table, refCols: [c.references.col], onDelete: c.references.onDelete });
        if (c.unique) applyOp(m, { op: "add_unique", table: name, cols: [c.name] });
      }
      break;
    }
    case "drop_table": {
      const name = qualify(op.table);
      delete m.tables[name];
      for (const t of Object.values(m.tables)) t.fks = t.fks.filter((f) => f.refTable !== name); // CASCADE drops them
      break;
    }
    case "rename_table": {
      const from = qualify(op.table);
      const to = op.to.includes(".") ? op.to : `${from.slice(0, from.lastIndexOf("."))}.${op.to}`;
      const t = ensure(m, from);
      delete m.tables[from];
      t.name = to;
      m.tables[to] = t;
      for (const o of Object.values(m.tables)) for (const f of o.fks) if (f.refTable === from) f.refTable = to;
      break;
    }
    case "add_column": {
      const t = tableOf();
      const c = toColumn(op.column);
      const i = t.columns.findIndex((x) => x.name === c.name);
      if (i < 0) t.columns.push(c);
      else if (t.columns[i].type === UNKNOWN_TYPE) t.columns[i] = c; // stub column learns its real shape
      if (op.column.references)
        addFk(m, t, { op: "add_fk", table: t.name, cols: [c.name], refTable: op.column.references.table, refCols: [op.column.references.col], onDelete: op.column.references.onDelete });
      if (op.column.unique) applyOp(m, { op: "add_unique", table: t.name, cols: [c.name] });
      break;
    }
    case "drop_column": {
      const t = tableOf();
      t.columns = t.columns.filter((c) => c.name !== op.column);
      const keep = <X extends { cols: string[] }>(xs: X[]) => xs.filter((x) => !x.cols.includes(op.column));
      t.fks = keep(t.fks); t.checks = keep(t.checks); t.uniques = keep(t.uniques); t.indexes = keep(t.indexes);
      break;
    }
    case "rename_column": renameColumn(m, tableOf(), op.column, op.to); break;
    case "alter_column": {
      const c = ensureCol(tableOf(), op.column, op.type);
      if (op.type) c.type = op.type;
      if (op.nullable !== undefined) c.nullable = op.nullable;
      if (op.default === null) delete c.default;
      else if (op.default !== undefined) c.default = op.default;
      break;
    }
    case "add_fk": addFk(m, tableOf(), op); break;
    case "add_check": {
      const t = tableOf();
      const name = op.name ?? autoName(t, op.cols, "check");
      t.checks = t.checks.filter((c) => c.name !== name);
      t.checks.push({ name, cols: op.cols, ...(op.allowed && { allowed: op.allowed }) });
      break;
    }
    case "add_unique": {
      const t = tableOf();
      op.cols.forEach((c) => ensureCol(t, c));
      const name = op.name ?? autoName(t, op.cols, "key");
      if (name.endsWith("_pkey")) {
        for (const c of t.columns) if (op.cols.includes(c.name)) Object.assign(c, { pk: true, nullable: false });
        break;
      }
      t.uniques = t.uniques.filter((u) => u.name !== name);
      t.uniques.push({ name, cols: op.cols });
      break;
    }
    case "drop_constraint": {
      const t = tableOf();
      if (op.name === `${local(t.name)}_pkey`) for (const c of t.columns) delete c.pk;
      t.fks = t.fks.filter((x) => x.name !== op.name);
      t.checks = t.checks.filter((x) => x.name !== op.name);
      t.uniques = t.uniques.filter((x) => x.name !== op.name);
      break;
    }
    case "add_index": {
      const t = tableOf();
      for (const c of op.cols) if (/^\w+$/.test(c)) ensureCol(t, c);
      const name = op.name ? local(op.name) : autoName(t, op.cols.map((c) => c.replace(/\W+/g, "")), "idx", new Set(t.indexes.map((i) => i.name)));
      t.indexes = t.indexes.filter((i) => i.name !== name);
      t.indexes.push({ name, cols: op.cols, unique: !!op.unique, partial: !!op.partial });
      break;
    }
    case "drop_index": {
      const name = local(op.name);
      for (const t of Object.values(m.tables)) t.indexes = t.indexes.filter((i) => i.name !== name);
      break;
    }
    case "rename_index": {
      const name = local(op.name);
      for (const t of Object.values(m.tables)) for (const i of t.indexes) if (i.name === name) i.name = op.to;
      break;
    }
    case "rename_constraint": {
      const t = tableOf();
      for (const x of [...t.fks, ...t.checks, ...t.uniques]) if (x.name === op.name) x.name = op.to;
      // a unique/pk constraint's backing index carries the same name
      for (const i of t.indexes) if (i.name === op.name) i.name = op.to;
      break;
    }
    case "set_enum": for (const x of expandSetEnum(m, op)) applyOp(m, x, migId); break;
    case "rls": tableOf().rls = op.on; break;
    case "add_policy": {
      const t = tableOf();
      if (!t.policies.includes(op.name)) t.policies.push(op.name);
      break;
    }
    case "drop_policy": {
      const t = m.tables[qualify(op.table)];
      if (t) t.policies = t.policies.filter((x) => x !== op.name);
      break;
    }
    case "rename_policy": {
      const t = tableOf();
      t.policies = t.policies.map((x) => (x === op.name ? op.to : x));
      break;
    }
    case "add_trigger": {
      const t = tableOf();
      if (!t.triggers.includes(op.name)) t.triggers.push(op.name);
      break;
    }
    case "drop_trigger": {
      const t = m.tables[qualify(op.table)];
      if (t) t.triggers = t.triggers.filter((x) => x !== op.name);
      break;
    }
    case "view":
    case "function": {
      const list = op.op === "view" ? m.views : m.functions;
      const i = list.indexOf(op.name);
      if (op.drop) { if (i >= 0) list.splice(i, 1); }
      else if (i < 0) list.push(op.name);
      break;
    }
    case "data": tableOf(); break;
    case "comment": {
      const t = tableOf();
      if (op.column) {
        const c = t.columns.find((x) => x.name === op.column);
        if (c) c.comment = op.text || undefined;
      } else t.comment = op.text || undefined;
      break;
    }
    case "dynamic":
    case "guard":
    case "txn":
      break;
  }
}

export function applyOps(m: SchemaModel, ops: SchemaOp[], migId?: string): SchemaModel {
  for (const op of ops) applyOp(m, op, migId);
  return m;
}

export const cloneModel = (m: SchemaModel): SchemaModel => structuredClone(m);

// tables an op list touches, by their name after the ops ran (renames followed)
export function touchedTables(ops: SchemaOp[], before?: SchemaModel): string[] {
  const out: string[] = [];
  const add = (t: string) => { if (!out.includes(t)) out.push(t); };
  for (const op of ops) {
    if (op.op === "rename_table") {
      const from = qualify(op.table);
      const to = op.to.includes(".") ? op.to : `${from.slice(0, from.lastIndexOf("."))}.${op.to}`;
      const i = out.indexOf(from);
      if (i >= 0) out.splice(i, 1);
      add(to);
    } else if (op.op === "drop_index" || op.op === "rename_index") {
      const name = local(op.name);
      const t = before && Object.values(before.tables).find((x) => x.indexes.some((i) => i.name === name));
      if (t) add(t.name);
    } else if ("table" in op && op.op !== "comment") add(qualify(op.table));
  }
  return out;
}
