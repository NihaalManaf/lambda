import { describe, expect, it } from "vitest";
import { applyOps, cloneModel, emptyModel } from "./apply";
import { opsToSql } from "./emit";
import { opsOf, step } from "./testutil";

const SEED = `create table t (id int primary key, s text, constraint t_s_custom check (s in ('a','b')), constraint c_new unique (s));
  create index t_s_idx_new on t (s); create policy p on t using (true);`;

describe("schema fixes", () => {
  it("follows index, constraint and policy renames, and policy drops", async () => {
    const { after } = await step(`drop index if exists t_s_idx; alter index t_s_idx_new rename to t_s_idx;
      alter table t rename constraint c_new to c; alter policy p on t rename to q; drop policy if exists q on t;`, SEED);
    const t = after.tables["public.t"];
    expect(t.indexes.map((i) => i.name)).toEqual(["t_s_idx"]);
    expect(t.uniques.map((u) => u.name)).toEqual(["c"]);
    expect(t.policies).toEqual([]);
  });

  it("never replays temp tables", async () => {
    const { after } = await step(`create temp table x on commit drop as select 1; insert into x values (1); create temp table y (a int);`, SEED);
    expect(Object.keys(after.tables).filter((k) => /\.(x|y)$/.test(k))).toEqual([]);
  });

  it("drops only what the model has", async () => {
    const { risks } = await step(`alter table t drop column if exists ghost; drop table if exists nope;`, SEED);
    expect(risks.map((r) => r.rule)).toEqual([]);
  });

  it("set_enum emits a drop of the real check name", async () => {
    const head = applyOps(emptyModel(), await opsOf(SEED));
    const sql = opsToSql([{ op: "set_enum", table: "t", column: "s", values: ["a", "b", "c"] }], head);
    expect(sql).toContain("DROP CONSTRAINT t_s_custom");
    const t = applyOps(cloneModel(head), await opsOf(sql)).tables["public.t"];
    expect(t.checks).toEqual([{ name: "t_s_custom", cols: ["s"], allowed: ["a", "b", "c"] }]);
  });
});
