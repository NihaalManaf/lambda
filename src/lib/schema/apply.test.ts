import { describe, expect, it } from "vitest";
import { applyOps, emptyModel, expandSetEnum } from "./apply";
import { opsOf } from "./testutil";

describe("apply", () => {
  it("auto-names constraints like postgres so DROP CONSTRAINT resolves", async () => {
    const m = applyOps(emptyModel(), await opsOf(`create table t (id uuid primary key, team_id uuid references team(id), s text check (s in ('a')), code text unique);`));
    const t = m.tables["public.t"];
    expect(t.fks[0].name).toBe("t_team_id_fkey");
    expect(t.checks[0].name).toBe("t_s_check");
    expect(t.uniques[0].name).toBe("t_code_key");
    expect(t.columns[0].pk).toBe(true);
    applyOps(m, await opsOf(`alter table t drop constraint t_team_id_fkey, drop constraint t_s_check, drop constraint t_code_key, drop constraint t_pkey;`));
    expect([t.fks, t.checks, t.uniques]).toEqual([[], [], []]);
    expect(t.columns[0].pk).toBeUndefined();
  });

  it("set_enum expands to drop + add of the check", async () => {
    const m = applyOps(emptyModel(), await opsOf(`create table t (s text constraint s_vals check (s in ('a','b')));`));
    const ops = expandSetEnum(m, { op: "set_enum", table: "t", column: "s", values: ["a", "c"] });
    expect(ops).toEqual([
      { op: "drop_constraint", table: "public.t", name: "s_vals" },
      { op: "add_check", table: "public.t", name: "s_vals", cols: ["s"], allowed: ["a", "c"] },
    ]);
    applyOps(m, [{ op: "set_enum", table: "t", column: "s", values: ["a", "c"] }]);
    expect(m.tables["public.t"].checks).toEqual([{ name: "s_vals", cols: ["s"], allowed: ["a", "c"] }]);
  });

  it("creates stubs for unknown tables and rewrites fk targets on rename", async () => {
    const m = applyOps(emptyModel(), await opsOf(`alter table team add column x int; create table a (team_id uuid references team(id)); alter table team rename to teams;`));
    expect(m.tables["public.teams"].origin).toBe("stub");
    expect(m.tables["public.teams"].columns.map((c) => c.name)).toEqual(["x", "id"]);
    expect(m.tables["public.a"].fks[0].refTable).toBe("public.teams");
    expect(m.tables["auth.users"].origin).toBe("baseline");
  });

  it("drop table removes the fks pointing at it", async () => {
    const m = applyOps(emptyModel(), await opsOf(`create table p (id int primary key); create table c (p_id int references p(id)); drop table p cascade;`));
    expect(m.tables["public.p"]).toBeUndefined();
    expect(m.tables["public.c"].fks).toEqual([]);
  });
});
