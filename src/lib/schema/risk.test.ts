import { describe, expect, it } from "vitest";
import { RULES } from "./risk";
import { step } from "./testutil";

const SEED = `create table t (id int primary key, a int, s text check (s in ('x','y')));`;
// rule -> [sql, seed, meta]: one minimal migration that trips it
const CASES: Record<string, [string, string?, { dupPrefix?: boolean; parseError?: string }?]> = {
  "drop-table": ["drop table t;", SEED],
  "drop-column": ["alter table t drop column a;", SEED],
  rename: ["alter table t rename column a to b;", SEED],
  "type-change": ["alter table t alter column a type bigint;", SEED],
  "not-null-fails": ["alter table t add column b int not null;", SEED],
  "not-null-risk": ["alter table t alter column a set not null;", SEED],
  "locks-writes": ["create index on t (a);", SEED],
  "fails-in-txn": ["begin; create index concurrently on t (a); commit;", SEED],
  "enum-removed": ["alter table t drop constraint t_s_check, add constraint t_s_check check (s in ('x'));", SEED],
  "full-scan-fk": ["alter table t add foreign key (a) references t(id);", SEED],
  cascade: ["create table c (t_id int references t(id) on delete cascade);", SEED],
  "rewrites-data": ["update t set a = 1; update t set a = 2;", SEED],
  dynamic: ["do $$ begin execute 'select 1'; end $$;", SEED],
  "rls-no-policy": ["alter table t enable row level security;", SEED],
  "baseline-unknown": ["alter table never_created add column a int;"],
  "same-timestamp": ["select 1;", "", { dupPrefix: true }],
  "parse-failed": ["select 1;", "", { parseError: "line 3: syntax error" }],
  "safety-check": ["do $$ begin if (select count(*) from t) > 0 then raise exception 'no'; end if; end $$;", SEED],
};

describe("risk rules", () => {
  it("has a case per rule", () => expect(Object.keys(CASES).sort()).toEqual(Object.keys(RULES).sort()));

  it.each(Object.entries(CASES))("%s fires", async (rule, [sql, seed, meta]) => {
    const { risks } = await step(sql, seed, meta);
    const r = risks.find((x) => x.rule === rule);
    expect(r).toBeDefined();
    expect(r!.label.split(" ").length).toBeLessThanOrEqual(3);
    expect(r!.why.split(" ").length).toBeLessThanOrEqual(12);
  });

  it("stays quiet on safe changes", async () => {
    const { risks } = await step("create table n (id int primary key, t_id int references t(id)); create index on n (t_id); alter table t add column b int;", SEED);
    expect(risks).toEqual([]);
  });

  it("not-valid fk and concurrent index outside txn are fine", async () => {
    const { risks } = await step("alter table t add foreign key (a) references t(id) not valid; create index concurrently on t (a);", SEED);
    expect(risks).toEqual([]);
  });
});
