// SchemaOp[] -> SQL, deterministic. Only for the </> toggle and handing to agents; parses back to the same ops.
import { applyOp, cloneModel, expandSetEnum } from "./apply";
import type { ColSpec, SchemaModel, SchemaOp } from "./types";

const RESERVED = new Set(["user", "order", "group", "table", "select", "from", "where", "to", "default", "check", "column", "primary", "references", "end", "limit", "offset", "desc", "asc", "all", "and", "or", "not", "null", "true", "false", "case", "when", "then", "else", "as", "on", "in", "is", "using", "unique", "foreign", "key", "create", "grant", "constraint"]);
export const ident = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) && !RESERVED.has(s) ? s : `"${s.replace(/"/g, '""')}"`);
const rel = (t: string) => (t.includes(".") ? t : `public.${t}`).split(".").map(ident).join(".");
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const list = (cols: string[]) => cols.map((c) => (/^\w+$/.test(c) ? ident(c) : `(${c})`)).join(", ");
const named = (n?: string) => (n ? `CONSTRAINT ${ident(n)} ` : "");
const alter = (t: string, body: string) => `ALTER TABLE ${rel(t)} ${body};`;

function colDef(c: ColSpec, inlinePk = true): string {
  let s = `${ident(c.name)} ${c.type}`;
  if (c.pk && inlinePk) s += " PRIMARY KEY";
  else if (c.pk) s += " NOT NULL";
  else if (c.nullable === false) s += " NOT NULL";
  if (c.default !== undefined) s += ` DEFAULT ${c.default}`;
  if (c.unique) s += " UNIQUE";
  if (c.references) s += ` REFERENCES ${rel(c.references.table)} (${ident(c.references.col)})${c.references.onDelete ? ` ON DELETE ${c.references.onDelete}` : ""}`;
  return s;
}

function opSql(o: SchemaOp): string {
  switch (o.op) {
    case "add_table": {
      // a composite key is only valid as a table constraint
      const pk = o.columns.filter((c) => c.pk).map((c) => c.name);
      const lines = o.columns.map((c) => `  ${colDef(c, pk.length < 2)}`);
      if (pk.length > 1) lines.push(`  PRIMARY KEY (${list(pk)})`);
      return `CREATE TABLE ${o.ifNotExists ? "IF NOT EXISTS " : ""}${rel(o.table)} (\n${lines.join(",\n")}\n);`;
    }
    case "drop_table": return `DROP TABLE ${rel(o.table)};`;
    case "rename_table": return alter(o.table, `RENAME TO ${ident(o.to.slice(o.to.lastIndexOf(".") + 1))}`);
    case "add_column": return alter(o.table, `ADD COLUMN ${colDef(o.column)}`);
    case "drop_column": return alter(o.table, `DROP COLUMN ${ident(o.column)}`);
    case "rename_column": return alter(o.table, `RENAME COLUMN ${ident(o.column)} TO ${ident(o.to)}`);
    case "alter_column": {
      const c = `ALTER COLUMN ${ident(o.column)}`;
      const out: string[] = [];
      if (o.type) out.push(alter(o.table, `${c} TYPE ${o.type}`));
      if (o.nullable !== undefined) out.push(alter(o.table, `${c} ${o.nullable ? "DROP" : "SET"} NOT NULL`));
      if (o.default === null) out.push(alter(o.table, `${c} DROP DEFAULT`));
      else if (o.default !== undefined) out.push(alter(o.table, `${c} SET DEFAULT ${o.default}`));
      return out.join("\n");
    }
    case "add_fk":
      return alter(o.table, `ADD ${named(o.name)}FOREIGN KEY (${list(o.cols)}) REFERENCES ${rel(o.refTable)}${o.refCols.length ? ` (${list(o.refCols)})` : ""}${o.onDelete ? ` ON DELETE ${o.onDelete}` : ""}${o.notValid ? " NOT VALID" : ""}`);
    case "add_check":
      return o.allowed
        ? alter(o.table, `ADD ${named(o.name)}CHECK (${ident(o.cols[0])} IN (${o.allowed.map(lit).join(", ")}))`)
        : `${alter(o.table, `ADD ${named(o.name)}CHECK (true)`)} -- TODO condition on ${o.cols.join(", ")}`;
    case "add_unique":
      return alter(o.table, `ADD ${named(o.name)}${o.name?.endsWith("_pkey") ? "PRIMARY KEY" : "UNIQUE"} (${list(o.cols)})`);
    case "drop_constraint": return alter(o.table, `DROP CONSTRAINT ${ident(o.name)}`);
    case "add_index":
      return `CREATE ${o.unique ? "UNIQUE " : ""}INDEX ${o.concurrently ? "CONCURRENTLY " : ""}${o.name ? `${ident(o.name)} ` : ""}ON ${rel(o.table)} (${list(o.cols)})${o.partial ? " WHERE true /* TODO predicate */" : ""};`;
    case "drop_index": return `DROP INDEX ${o.name.split(".").map(ident).join(".")};`;
    case "rename_index": return `ALTER INDEX ${o.name.split(".").map(ident).join(".")} RENAME TO ${ident(o.to)};`;
    case "rename_constraint": return alter(o.table, `RENAME CONSTRAINT ${ident(o.name)} TO ${ident(o.to)}`);
    case "set_enum": {
      // no model here: callers expand against the model first (expandSetEnum) to get the real check name
      const n = ident(`${o.table.slice(o.table.lastIndexOf(".") + 1)}_${o.column}_check`);
      return [alter(o.table, `DROP CONSTRAINT IF EXISTS ${n}`), alter(o.table, `ADD CONSTRAINT ${n} CHECK (${ident(o.column)} IN (${o.values.map(lit).join(", ")}))`)].join("\n");
    }
    case "rls": return alter(o.table, `${o.on ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY`);
    case "add_policy": return `CREATE POLICY ${ident(o.name)} ON ${rel(o.table)} USING (true); -- TODO policy rule`;
    case "drop_policy": return `DROP POLICY ${ident(o.name)} ON ${rel(o.table)};`;
    case "rename_policy": return `ALTER POLICY ${ident(o.name)} ON ${rel(o.table)} RENAME TO ${ident(o.to)};`;
    case "add_trigger": return `CREATE TRIGGER ${ident(o.name)} AFTER INSERT OR UPDATE ON ${rel(o.table)} FOR EACH ROW EXECUTE FUNCTION ${ident(`${o.name}_fn`)}();`;
    case "drop_trigger": return `DROP TRIGGER ${ident(o.name)} ON ${rel(o.table)};`;
    case "view": return o.drop ? `DROP VIEW ${rel(o.name)};` : `CREATE VIEW ${rel(o.name)} AS SELECT 1; -- TODO query`;
    case "function": return o.drop ? `DROP FUNCTION ${rel(o.name)};` : `-- function ${o.name}`;
    case "data": return `-- TODO backfill: ${o.kind} ${o.table}`;
    case "comment": return `COMMENT ON ${o.column ? `COLUMN ${rel(o.table)}.${ident(o.column)}` : `TABLE ${rel(o.table)}`} IS ${lit(o.text)};`;
    case "dynamic": return `-- dynamic: ${o.note.replace(/\n/g, " ")}`;
    case "guard": return "-- safety check";
    case "txn": return o.kind === "begin" ? "BEGIN;" : "COMMIT;";
  }
}

// with the model the ops apply to, set_enum drops the column's real check (not the default name)
export function opsToSql(ops: SchemaOp[], model?: SchemaModel): string {
  const m = model && cloneModel(model);
  const out = m
    ? ops.flatMap((o) => {
        const xs = o.op === "set_enum" ? expandSetEnum(m, o) : [o];
        for (const x of xs) applyOp(m, x);
        return xs;
      })
    : ops;
  return out.map(opSql).join("\n") + "\n";
}
