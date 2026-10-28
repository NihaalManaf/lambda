import { describe, expect, it } from "vitest";
import { parseSql } from "./parse";
import { opsOf } from "./testutil";

describe("parse", () => {
  it("splits inline constraints out of create table", async () => {
    const ops = await opsOf(`create table if not exists t (
      id uuid primary key default gen_random_uuid(),
      team_id uuid not null references team(id) on delete cascade,
      status text not null default 'a' check (status in ('a','b')),
      code text unique
    );`);
    expect(ops[0]).toEqual({
      op: "add_table", table: "public.t", ifNotExists: true,
      columns: [
        { name: "id", type: "uuid", pk: true, nullable: false, default: "gen_random_uuid()" },
        { name: "team_id", type: "uuid", nullable: false },
        { name: "status", type: "text", nullable: false, default: "'a'" },
        { name: "code", type: "text" },
      ],
    });
    expect(ops.slice(1)).toEqual([
      { op: "add_fk", table: "public.t", cols: ["team_id"], refTable: "public.team", refCols: ["id"], onDelete: "CASCADE" },
      { op: "add_check", table: "public.t", cols: ["status"], allowed: ["a", "b"] },
      { op: "add_unique", table: "public.t", cols: ["code"] },
    ]);
  });

  it("reads enum checks written as = ANY(ARRAY[...])", async () => {
    const [op] = await opsOf(`alter table t add constraint c check ((s)::text = any (array['x'::text, 'y'::text]))`);
    expect(op).toMatchObject({ op: "add_check", name: "c", cols: ["s"], allowed: ["x", "y"] });
  });

  it("covers alter/rename/drop/index/policy/trigger/data/txn", async () => {
    const ops = await opsOf(`begin;
      alter table t drop column a, alter column b set not null, alter column c type bigint, alter column d drop default,
        drop constraint if exists k, enable row level security;
      alter table t rename column x to y; alter table t rename to u;
      create unique index concurrently i on t (a) where a > 0; drop index if exists j;
      create policy p on t using (true); create trigger tr after insert on t for each row execute function f();
      drop trigger tr on t; update t set a = 1; insert into t values (1); delete from t;
      create view v as select 1; drop table if exists z; commit;`);
    expect(ops.map((o) => o.op)).toEqual([
      "txn", "drop_column", "alter_column", "alter_column", "alter_column", "drop_constraint", "rls", "rename_column", "rename_table",
      "add_index", "drop_index", "add_policy", "add_trigger", "drop_trigger", "data", "data", "data", "view", "drop_table", "txn",
    ]);
    expect(ops[9]).toEqual({ op: "add_index", table: "public.t", name: "i", cols: ["a"], unique: true, partial: true, concurrently: true });
    expect(ops[8]).toEqual({ op: "rename_table", table: "public.t", to: "public.u" });
  });

  it("walks DO blocks: then-branch ddl, dynamic execute, raise guards", async () => {
    const ops = await opsOf(`do $$ declare n int; begin
      if not exists (select 1 from pg_constraint where conname = 'k') then
        alter table t add constraint k foreign key (a) references u(id) not valid;
      else alter table t add column never int; end if;
      execute format('alter table %I add column y int', 't');
      select count(*) into n from t;
      if n > 0 then raise exception 'orphans %', n; end if;
      raise notice 'fine';
    end $$;`);
    expect(ops.map((o) => o.op)).toEqual(["add_fk", "dynamic", "guard"]);
    expect(ops[0]).toMatchObject({ name: "k", notValid: true });
  });

  it("strips psql meta commands and counts \\gexec as dynamic", async () => {
    const r = await parseSql(`select 'alter table t add column z int' \\gexec\n\\gexec\nalter table t add column a int;`);
    expect(r.error).toBeUndefined();
    expect(r.ops.map((o) => o.op)).toEqual(["add_column", "dynamic", "dynamic"]);
  });

  it("returns an error with a line instead of throwing", async () => {
    const r = await parseSql("select 1;\nselec x;");
    expect(r.ops).toEqual([]);
    expect(r.error?.line).toBe(2);
  });
});
