import { describe, expect, it } from "vitest";
import { touchedTables } from "./apply";
import { opsSummary, shortType, toErd } from "./graph";
import { step } from "./testutil";

describe("graph", () => {
  it("short types", () => {
    expect(["int4", "bigint", "timestamptz", "timestamp", "varchar", "citext", "jsonb", "numeric", "float8", "text[]", "uuid", "boolean"].map(shortType))
      .toEqual(["int", "int", "time", "time", "text", "text", "json", "num", "num", "text[]", "uuid", "bool"]);
  });

  it("context is only the fk neighbours the change runs through", async () => {
    const seed = `create table hub (id int primary key, name text, extra text);` +
      Array.from({ length: 10 }, (_, i) => `create table s${i} (id int primary key, hub_id int references hub(id), junk text);`).join("");
    const { before, after, ops, risks } = await step("alter table hub add column flag boolean;", seed);
    const g = toErd(before, after, touchedTables(ops, before), risks, ops);
    expect(g.tables.map((t) => t.id)).toEqual(["public.hub"]);
    expect(g.overflow).toHaveLength(10);
  });

  it("touched first, fk neighbours as context with key columns only, capped", async () => {
    const seed = `create table hub (id int primary key, name text, extra text);` +
      Array.from({ length: 10 }, (_, i) => `create table s${i} (id int primary key, hub_id int references hub(id), junk text);`).join("");
    const { before, after, ops, risks } = await step("alter table hub alter column id type bigint;", seed);
    const g = toErd(before, after, touchedTables(ops, before), risks, ops);
    expect(g.tables).toHaveLength(4);
    expect(g.overflow).toHaveLength(7);
    expect(g.tables[0]).toMatchObject({ id: "public.hub", diff: "changed" });
    const id = g.tables[0].cols.find((c) => c.name === "id")!;
    expect(id).toMatchObject({ diff: "changed", pinned: true, type: "int" });
    expect(g.tables[0].cols.find((c) => c.name === "name")!.pinned).toBe(false);
    const ctx = g.tables[1];
    expect(ctx.diff).toBe("context");
    expect(ctx.cols.map((c) => c.name).sort()).toEqual(["hub_id", "id"]);
    expect(g.edges.filter((e) => e.to === "public.hub")).toHaveLength(3);
  });

  it("ops summary rows stay <= 4 words", async () => {
    const { ops } = await step("alter table t add column a int, add column b int, add column c int; create index on t (a); alter table t rename to u;", "create table t (id int);");
    const rows = opsSummary(ops);
    expect(rows.map((r) => [r.table, r.text])).toEqual([["t", "+ 3 columns"], ["t", "+ index"], ["t", "→ u"]]);
    for (const r of rows) expect(r.text.split(" ").length).toBeLessThanOrEqual(4);
  });
});
