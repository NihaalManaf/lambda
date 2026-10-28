// Migration risk rules (spec §2.1). Labels <=3 words, why <=12 words.
import type { Risk, RiskLevel } from "../types";
import { bare, qualify, touchedTables } from "./apply";
import { enumOf } from "./diff";
import type { MigrationMeta, SchemaModel, SchemaOp } from "./types";

type Meta = Pick<MigrationMeta, "id" | "dupPrefix" | "parseError">;
type Target = Risk["target"];

export const RULES: Record<string, { label: string; level: RiskLevel }> = {
  "drop-table": { label: "drops table", level: "bad" },
  "drop-column": { label: "drops column", level: "bad" },
  rename: { label: "rename breaks code", level: "warn" },
  "type-change": { label: "type change", level: "warn" },
  "not-null-fails": { label: "not null fails", level: "bad" },
  "not-null-risk": { label: "not null risk", level: "warn" },
  "locks-writes": { label: "locks writes", level: "warn" },
  "fails-in-txn": { label: "fails in txn", level: "bad" },
  "enum-removed": { label: "enum value removed", level: "warn" },
  "full-scan-fk": { label: "full scan fk", level: "warn" },
  cascade: { label: "cascade delete", level: "info" },
  "rewrites-data": { label: "rewrites data", level: "info" },
  dynamic: { label: "dynamic sql", level: "info" },
  "rls-no-policy": { label: "rls no policy", level: "warn" },
  "baseline-unknown": { label: "baseline unknown", level: "info" },
  "same-timestamp": { label: "same timestamp", level: "info" },
  "parse-failed": { label: "parse failed", level: "bad" },
  "safety-check": { label: "has safety check", level: "info" },
};

const RANK: Record<RiskLevel, number> = { bad: 0, warn: 1, info: 2 };
export const worstOf = (risks: Risk[]): RiskLevel | null =>
  risks.reduce<RiskLevel | null>((w, r) => (w === null || RANK[r.level] < RANK[w] ? r.level : w), null);

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function risk(ops: SchemaOp[], before: SchemaModel, after: SchemaModel, meta: Meta): Risk[] {
  // one chip per (rule, table): items collect the columns/count behind it
  const hits = new Map<string, { rule: string; target: Target; items: string[] }>();
  const hit = (rule: string, target: Target, item = "") => {
    const key = `${rule}:${target.id}`;
    const h = hits.get(key) ?? hits.set(key, { rule, target, items: [] }).get(key)!;
    if (item && !h.items.includes(item)) h.items.push(item);
    else if (!item) h.items.push("");
  };
  const mig: Target = { kind: "migration", id: meta.id };
  const tbl = (t: string): Target => ({ kind: "table", id: qualify(t) });
  const col = (t: string, c: string): Target => ({ kind: "column", id: qualify(t), col: c });

  const created = new Set<string>();
  const dataOn = new Set(ops.flatMap((o) => (o.op === "data" ? [qualify(o.table)] : [])));
  let inTxn = false;
  for (const op of ops) {
    const t = "table" in op ? qualify(op.table) : "";
    const existed = t && !created.has(t);
    switch (op.op) {
      case "add_table": created.add(t);
        for (const c of op.columns) if (c.references?.onDelete === "CASCADE") hit("cascade", col(t, c.name), c.name);
        break;
      // IF EXISTS on something the model never had: nothing is lost
      case "drop_table": if (before.tables[t] || created.has(t)) hit("drop-table", tbl(t)); break;
      case "drop_column": {
        const b = before.tables[t];
        if (!b || b.origin === "stub" || b.columns.some((c) => c.name === op.column)) hit("drop-column", col(t, op.column), op.column);
        break;
      }
      case "rename_table": {
        const to = op.to.includes(".") ? op.to : `${t.slice(0, t.lastIndexOf("."))}.${op.to}`;
        hit("rename", tbl(to), bare(t));
        break;
      }
      case "rename_column": hit("rename", col(t, op.to), op.column); break;
      case "add_column":
        if (existed && op.column.nullable === false && op.column.default === undefined && !op.column.pk)
          hit("not-null-fails", col(t, op.column.name), op.column.name);
        if (op.column.references?.onDelete === "CASCADE") hit("cascade", col(t, op.column.name), op.column.name);
        if (existed && op.column.references) hit("full-scan-fk", col(t, op.column.name), op.column.name);
        break;
      case "alter_column":
        if (op.type) hit("type-change", col(t, op.column), op.column);
        if (op.nullable === false && !dataOn.has(t)) hit("not-null-risk", col(t, op.column), op.column);
        break;
      case "add_index":
        if (op.concurrently && inTxn) hit("fails-in-txn", tbl(t));
        if (existed && !op.concurrently) hit("locks-writes", tbl(t), op.name ?? op.cols.join(","));
        break;
      case "add_fk":
        if (existed && !op.notValid) hit("full-scan-fk", col(t, op.cols[0]), op.cols.join(","));
        if (op.onDelete === "CASCADE") hit("cascade", col(t, op.cols[0]), op.cols.join(","));
        break;
      case "data": hit("rewrites-data", tbl(t)); break;
      case "dynamic": hit("dynamic", mig); break;
      case "guard": hit("safety-check", mig); break;
      case "txn": inTxn = op.kind === "begin"; break;
    }
  }

  for (const t of touchedTables(ops, before)) {
    const a = after.tables[t];
    const b = before.tables[t];
    if (a?.origin === "stub") hit("baseline-unknown", tbl(t));
    if (a?.rls && !a.policies.length && ops.some((o) => o.op === "rls" && o.on && qualify(o.table) === t)) hit("rls-no-policy", tbl(t));
    if (a && b)
      for (const c of b.columns) {
        const was = enumOf(b, c.name);
        const now = enumOf(a, c.name);
        if (was && now && was.some((v) => !now.includes(v))) hit("enum-removed", col(t, c.name), c.name);
      }
  }
  if (meta.dupPrefix) hit("same-timestamp", mig);
  if (meta.parseError) hit("parse-failed", mig);

  return [...hits.values()].map(({ rule, target, items }) => {
    const r = RULES[rule];
    const name = bare(target.id);
    const n = items.length;
    const what = items.filter(Boolean);
    const why: Record<string, string> = {
      "drop-table": `${name} and its rows are gone`,
      "drop-column": n > 1 ? `${name} loses ${plural(n, "column")} and data` : `${name}.${what[0]} data is gone`,
      rename: `old name ${what[0]} breaks queries still using it`,
      "type-change": `${name}.${what[0]} rewritten, table locked meanwhile`,
      "not-null-fails": `existing rows have no ${what[0]}: add fails`,
      "not-null-risk": `existing nulls in ${what[0]} make this fail`,
      "locks-writes": `index build blocks writes to ${name}`,
      "fails-in-txn": "concurrent index can't run inside a transaction",
      "enum-removed": `rows with dropped ${what[0]} values fail check`,
      "full-scan-fk": `validating fk scans all of ${name}`,
      cascade: `deleting parent row deletes ${name} rows`,
      "rewrites-data": `${plural(n, "data statement")} on ${name}`,
      dynamic: `${plural(n, "dynamic statement")}: effect unknown until run`,
      "rls-no-policy": `rls on with no policy: ${name} unreadable`,
      "baseline-unknown": `${name} predates migrations: columns partial`,
      "same-timestamp": "another migration shares this timestamp prefix",
      "parse-failed": meta.parseError ? meta.parseError.split(/\s+/).slice(0, 10).join(" ") : "file did not parse",
      "safety-check": "aborts itself if data looks wrong",
    };
    return {
      id: `${rule}:${target.id}`,
      rule, level: r.level, label: r.label, why: why[rule],
      target: target.kind === "column" && what.length > 1 ? tbl(target.id) : target,
    };
  }).sort((a, b) => RANK[a.level] - RANK[b.level]);
}
