import { describe, expect, it } from "vitest";
import { diff } from "./diff";
import { step } from "./testutil";

describe("diff", () => {
  it("marks columns added/removed/changed/renamed with before values and enum changes", async () => {
    const { before, after, ops } = await step(
      `alter table t add column b int; alter table t drop column c; alter table t alter column a set not null;
       alter table t rename column d to e; alter table t drop constraint t_s_check, add constraint t_s_check check (s in ('x','z'));`,
      `create table t (id int primary key, a int, c int, d int, s text check (s in ('x','y')));`,
    );
    const d = diff(before, after, ops)["public.t"];
    const by = Object.fromEntries(d.cols.map((c) => [c.name, c]));
    expect(d.diff).toBe("changed");
    expect(by.b.diff).toBe("added");
    expect(by.c.diff).toBe("removed");
    expect(by.a).toMatchObject({ diff: "changed", before: { required: false } });
    expect(by.e).toMatchObject({ diff: "renamed", from: "d" });
    expect(by.s.enumValues).toEqual([{ v: "x", diff: "same" }, { v: "z", diff: "added" }, { v: "y", diff: "removed" }]);
  });

  it("detects table renames from ops", async () => {
    const { before, after, ops } = await step("alter table t rename to u;", "create table t (id int);");
    expect(diff(before, after, ops)["public.u"]).toMatchObject({ diff: "renamed", from: "public.t" });
  });

  it("new table is added, dropped table removed", async () => {
    const { before, after, ops } = await step("create table n (id int); drop table t;", "create table t (id int);");
    const d = diff(before, after, ops);
    expect(d["public.n"].diff).toBe("added");
    expect(d["public.t"].diff).toBe("removed");
  });
});
