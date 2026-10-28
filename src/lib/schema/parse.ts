// SQL text -> SchemaOp[] via Postgres' own parser (libpg-query, wasm). Pure: no server-only.
import { loadModule, parsePlPgSQLSync, parseSync } from "libpg-query";
import { deparseSync } from "pgsql-parser";
import type { ColSpec, Fk, SchemaOp } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any -- walking the raw libpg-query AST */
type N = any;

let mod: Promise<void> | null = null;
export const ready = () => (mod ??= loadModule());

export interface ParseResult { ops: SchemaOp[]; error?: { message: string; line: number } }

const s = (n: N): string => n?.String?.sval;
const rel = (r: N) => `${r.schemaname ?? "public"}.${r.relname}`;
const qname = (items: string[]) => (items.length > 1 ? items.join(".") : `public.${items[0]}`);
const short = (t: string) => t.replace(/^public\./, "");
const DEL: Record<string, Fk["onDelete"]> = { c: "CASCADE", n: "SET NULL", d: "SET DEFAULT", r: "RESTRICT" };
// pg internal names -> what people write, so emitted SQL round-trips
const TYPES: Record<string, string> = { int4: "int", int8: "bigint", int2: "smallint", bool: "boolean", float8: "float8", float4: "float4" };

export function typeStr(t: N): string {
  const parts = (t?.names ?? []).map(s).filter((x: string) => x !== "pg_catalog");
  const base = parts.join(".");
  return (TYPES[base] ?? base) + (t?.arrayBounds ? "[]" : "");
}

export function expr(n: N): string {
  try {
    return String(deparseSync([n] as never)).trim();
  } catch {
    return "?";
  }
}

const unwrap = (n: N): N => (n?.TypeCast ? unwrap(n.TypeCast.arg) : n);
const constStr = (n: N): string | undefined => {
  const c = unwrap(n)?.A_Const;
  if (!c) return undefined;
  return c.sval?.sval ?? (c.ival ? String(c.ival.ival ?? 0) : undefined);
};
const colRef = (n: N): string | undefined => {
  const f = unwrap(n)?.ColumnRef?.fields;
  return f ? s(f[f.length - 1]) : undefined;
};

// every column referenced in an expression, in order
function refs(n: N, out: string[] = []): string[] {
  if (Array.isArray(n)) n.forEach((x) => refs(x, out));
  else if (n && typeof n === "object") {
    if (n.ColumnRef) {
      const c = colRef(n);
      if (c && !out.includes(c)) out.push(c);
    } else for (const v of Object.values(n)) refs(v, out);
  }
  return out;
}

// col IN ('a','b') | col = ANY (ARRAY['a','b']) | col IS NULL OR <either>  ->  {col, values}
function enumOf(n: N): { col: string; values: string[] } | undefined {
  const b = n?.BoolExpr;
  if (b?.boolop === "OR_EXPR") {
    const nul = b.args.find((a: N) => a.NullTest);
    const rest = b.args.filter((a: N) => !a.NullTest);
    if (nul && rest.length === 1) return enumOf(rest[0]);
    return undefined;
  }
  const e = n?.A_Expr;
  if (!e || s(e.name?.[0]) !== "=") return undefined;
  const col = colRef(e.lexpr);
  const items = e.kind === "AEXPR_IN" ? e.rexpr?.List?.items : e.kind === "AEXPR_OP_ANY" ? unwrap(e.rexpr)?.A_ArrayExpr?.elements : undefined;
  if (!col || !items) return undefined;
  const values = items.map(constStr);
  return values.every((v: string | undefined) => v !== undefined) ? { col, values } : undefined;
}

// a constraint node -> ops (col = the column it was declared on, if inline)
function constraintOps(table: string, c: N, col?: string): SchemaOp[] {
  const name: string | undefined = c.conname;
  switch (c.contype) {
    case "CONSTR_CHECK": {
      const en = enumOf(c.raw_expr);
      const cols = en ? [en.col] : col ? [col] : refs(c.raw_expr);
      return [{ op: "add_check", table, ...(name && { name }), cols, ...(en && { allowed: en.values }) }];
    }
    case "CONSTR_FOREIGN":
      return [{
        op: "add_fk", table, ...(name && { name }), cols: col ? [col] : (c.fk_attrs ?? []).map(s), refTable: rel(c.pktable),
        refCols: (c.pk_attrs ?? []).map(s), ...(DEL[c.fk_del_action] && { onDelete: DEL[c.fk_del_action] }),
        ...(c.skip_validation && { notValid: true }),
      }];
    case "CONSTR_UNIQUE":
      return [{ op: "add_unique", table, ...(name && { name }), cols: col ? [col] : (c.keys ?? []).map(s) }];
    case "CONSTR_PRIMARY": // no pk op: a `_pkey` unique marks the columns as primary key in apply
      return [{ op: "add_unique", table, name: name ?? `${short(table)}_pkey`, cols: col ? [col] : (c.keys ?? []).map(s) }];
  }
  return [];
}

// ColumnDef -> ColSpec (+ inline FK/UNIQUE/CHECK split out into their own ops)
function column(table: string, d: N): { spec: ColSpec; extra: SchemaOp[] } {
  const spec: ColSpec = { name: d.colname, type: typeStr(d.typeName) };
  const extra: SchemaOp[] = [];
  for (const { Constraint: c } of d.constraints ?? []) {
    if (c.contype === "CONSTR_NOTNULL") spec.nullable = false;
    else if (c.contype === "CONSTR_NULL") spec.nullable = true;
    else if (c.contype === "CONSTR_DEFAULT") spec.default = expr(c.raw_expr);
    else if (c.contype === "CONSTR_PRIMARY" && !c.conname) Object.assign(spec, { pk: true, nullable: false });
    else extra.push(...constraintOps(table, c, d.colname));
  }
  return { spec, extra };
}

function alterOps(table: string, c: N): SchemaOp[] {
  const col = c.name as string;
  switch (c.subtype) {
    case "AT_AddColumn": {
      const r = column(table, c.def.ColumnDef);
      return [{ op: "add_column", table, column: r.spec }, ...r.extra];
    }
    case "AT_DropColumn": return [{ op: "drop_column", table, column: col }];
    case "AT_SetNotNull": return [{ op: "alter_column", table, column: col, nullable: false }];
    case "AT_DropNotNull": return [{ op: "alter_column", table, column: col, nullable: true }];
    case "AT_ColumnDefault": return [{ op: "alter_column", table, column: col, default: c.def ? expr(c.def) : null }];
    case "AT_AlterColumnType": return [{ op: "alter_column", table, column: col, type: typeStr(c.def.ColumnDef.typeName) }];
    case "AT_AddConstraint": return constraintOps(table, c.def.Constraint);
    case "AT_DropConstraint": return [{ op: "drop_constraint", table, name: col }];
    case "AT_EnableRowSecurity":
    case "AT_ForceRowSecurity": return [{ op: "rls", table, on: true }];
    case "AT_DisableRowSecurity": return [{ op: "rls", table, on: false }];
  }
  return [];
}

// DO block body: run the `then` branch of guards (they're idempotency checks), skip handlers
function walkPl(n: N, ops: SchemaOp[], temps: Set<string>) {
  if (Array.isArray(n)) return n.forEach((x) => walkPl(x, ops, temps));
  if (!n || typeof n !== "object") return;
  for (const [k, v] of Object.entries(n) as [string, N][]) {
    if (k === "datums" || k === "exceptions") continue;
    if (k === "PLpgSQL_stmt_if") walkPl(v.then_body, ops, temps);
    else if (k === "PLpgSQL_stmt_execsql") {
      const q = v.sqlstmt?.PLpgSQL_expr?.query;
      if (q) try { ops.push(...stmtOps(parseSync(q).stmts, temps)); } catch { /* plpgsql vars in sql: not ddl */ }
    } else if (k === "PLpgSQL_stmt_dynexecute") ops.push({ op: "dynamic", note: String(v.query?.PLpgSQL_expr?.query ?? "execute").slice(0, 80) });
    else if (k === "PLpgSQL_stmt_raise") { if ((v.elog_level ?? 21) >= 21) ops.push({ op: "guard", kind: "raise" }); }
    else walkPl(v, ops, temps);
  }
}

function doOps(n: N, temps: Set<string>): SchemaOp[] {
  const lang = n.args?.find((a: N) => a.DefElem?.defname === "language")?.DefElem.arg;
  if (lang && s(lang) !== "plpgsql") return [];
  const body = s(n.args?.find((a: N) => a.DefElem?.defname === "as")?.DefElem.arg);
  if (!body) return [];
  const ops: SchemaOp[] = [];
  let tag = "$lambda$";
  while (body.includes(tag)) tag = `$l${tag.slice(1)}`;
  walkPl(parsePlPgSQLSync(`DO ${tag}${body}${tag}`), ops, temps);
  return ops;
}

// temp tables live for one session: never part of the schema
const temp = (r: N) => r?.relpersistence === "t";

function stmtOps(stmts: N[] | undefined, temps = new Set<string>()): SchemaOp[] {
  const ops: SchemaOp[] = [];
  for (const { stmt } of stmts ?? []) {
    const [kind, n] = Object.entries(stmt ?? {})[0] ?? [];
    const x = n as N;
    switch (kind) {
      case "CreateStmt": {
        const table = rel(x.relation);
        if (temp(x.relation)) { temps.add(table); break; }
        const columns: ColSpec[] = [];
        const extra: SchemaOp[] = [];
        for (const e of x.tableElts ?? []) {
          if (e.ColumnDef) {
            const r = column(table, e.ColumnDef);
            columns.push(r.spec);
            extra.push(...r.extra);
          } else if (e.Constraint) {
            if (e.Constraint.contype === "CONSTR_PRIMARY" && !e.Constraint.conname)
              for (const k of (e.Constraint.keys ?? []).map(s)) {
                const c = columns.find((y) => y.name === k);
                if (c) Object.assign(c, { pk: true, nullable: false });
              }
            else extra.push(...constraintOps(table, e.Constraint));
          }
        }
        ops.push({ op: "add_table", table, columns, ...(x.if_not_exists && { ifNotExists: true }) }, ...extra);
        break;
      }
      case "CreateTableAsStmt":
        if (temp(x.into.rel)) temps.add(rel(x.into.rel));
        else if (x.objtype === "OBJECT_TABLE") ops.push({ op: "add_table", table: rel(x.into.rel), columns: [] });
        else if (x.objtype === "OBJECT_MATVIEW") ops.push({ op: "view", name: rel(x.into.rel) });
        break;
      case "AlterTableStmt":
        if (x.objtype === "OBJECT_TABLE") for (const { AlterTableCmd: c } of x.cmds ?? []) ops.push(...alterOps(rel(x.relation), c));
        break;
      case "RenameStmt":
        if (x.renameType === "OBJECT_TABLE") ops.push({ op: "rename_table", table: rel(x.relation), to: `${x.relation.schemaname ?? "public"}.${x.newname}` });
        else if (x.renameType === "OBJECT_COLUMN" && x.relationType === "OBJECT_TABLE")
          ops.push({ op: "rename_column", table: rel(x.relation), column: x.subname, to: x.newname });
        else if (x.renameType === "OBJECT_INDEX") ops.push({ op: "rename_index", name: x.relation.relname, to: x.newname });
        else if (x.renameType === "OBJECT_TABCONSTRAINT") ops.push({ op: "rename_constraint", table: rel(x.relation), name: x.subname, to: x.newname });
        else if (x.renameType === "OBJECT_POLICY") ops.push({ op: "rename_policy", table: rel(x.relation), name: x.subname, to: x.newname });
        break;
      case "DropStmt":
        for (const o of x.objects ?? []) {
          const items: string[] = (o.List?.items ?? []).map(s);
          if (x.removeType === "OBJECT_TABLE") ops.push({ op: "drop_table", table: qname(items) });
          else if (x.removeType === "OBJECT_INDEX") ops.push({ op: "drop_index", name: items[items.length - 1] });
          else if (x.removeType === "OBJECT_VIEW" || x.removeType === "OBJECT_MATVIEW") ops.push({ op: "view", name: qname(items), drop: true });
          else if (x.removeType === "OBJECT_FUNCTION" || x.removeType === "OBJECT_PROCEDURE")
            ops.push({ op: "function", name: qname((o.ObjectWithArgs?.objname ?? []).map(s)), drop: true });
          else if (x.removeType === "OBJECT_POLICY") ops.push({ op: "drop_policy", table: qname(items.slice(0, -1)), name: items[items.length - 1] });
          else if (x.removeType === "OBJECT_TRIGGER") ops.push({ op: "drop_trigger", table: qname(items.slice(0, -1)), name: items[items.length - 1] });
        }
        break;
      case "IndexStmt":
        ops.push({
          op: "add_index", table: rel(x.relation), ...(x.idxname && { name: x.idxname }),
          cols: (x.indexParams ?? []).map((p: N) => p.IndexElem.name ?? expr(p.IndexElem.expr)),
          ...(x.unique && { unique: true }), ...(x.whereClause && { partial: true }), ...(x.concurrent && { concurrently: true }),
        });
        break;
      case "CreatePolicyStmt": ops.push({ op: "add_policy", table: rel(x.table), name: x.policy_name }); break;
      case "CreateTrigStmt": ops.push({ op: "add_trigger", table: rel(x.relation), name: x.trigname }); break;
      case "ViewStmt": ops.push({ op: "view", name: rel(x.view) }); break;
      case "CreateFunctionStmt": ops.push({ op: "function", name: qname((x.funcname ?? []).map(s)) }); break;
      case "CommentStmt": {
        const items: string[] = (x.object?.List?.items ?? []).map(s);
        if (x.objtype === "OBJECT_TABLE") ops.push({ op: "comment", table: qname(items), text: x.comment ?? "" });
        else if (x.objtype === "OBJECT_COLUMN")
          ops.push({ op: "comment", table: qname(items.slice(0, -1)), column: items[items.length - 1], text: x.comment ?? "" });
        break;
      }
      case "UpdateStmt": ops.push({ op: "data", table: rel(x.relation), kind: "update" }); break;
      case "InsertStmt": ops.push({ op: "data", table: rel(x.relation), kind: "insert" }); break;
      case "DeleteStmt": ops.push({ op: "data", table: rel(x.relation), kind: "delete" }); break;
      case "TransactionStmt":
        if (x.kind === "TRANS_STMT_BEGIN" || x.kind === "TRANS_STMT_START") ops.push({ op: "txn", kind: "begin" });
        else if (x.kind === "TRANS_STMT_COMMIT" || x.kind === "TRANS_STMT_ROLLBACK") ops.push({ op: "txn", kind: "commit" });
        break;
      case "DoStmt": ops.push(...doOps(x, temps)); break;
    }
  }
  return temps.size ? ops.filter((o) => !("table" in o && temps.has(o.table))) : ops;
}

const META = /^\\\S.*$/gm; // psql meta-commands (\gexec, \restrict …) aren't SQL

// Sync: call after `await ready()`. Never throws: a bad file yields {ops: [], error}.
export function parseSqlSync(sql: string): ParseResult {
  const gexec = (sql.match(/\\gexec\b/g) ?? []).length;
  const clean = sql.replace(META, ";").replace(/\\gexec\s*$/gm, ";");
  try {
    const ops = stmtOps(parseSync(clean).stmts);
    for (let i = 0; i < gexec; i++) ops.push({ op: "dynamic", note: "\\gexec" });
    return { ops };
  } catch (e) {
    if (e instanceof Error && /query cannot be empty/i.test(e.message)) return { ops: [] }; // comment-only file
    const d = (e as { sqlDetails?: { cursorPosition?: number } }).sqlDetails;
    const line = d?.cursorPosition != null ? clean.slice(0, d.cursorPosition).split("\n").length : 0;
    return { ops: [], error: { message: e instanceof Error ? e.message : String(e), line } };
  }
}

export async function parseSql(sql: string): Promise<ParseResult> {
  await ready();
  return parseSqlSync(sql);
}
