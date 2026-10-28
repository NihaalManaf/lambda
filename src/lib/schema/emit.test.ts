import { describe, expect, it } from "vitest";
import { applyOps, emptyModel } from "./apply";
import { opsToSql } from "./emit";
import { opsOf } from "./testutil";

const CASES = [
  `create table if not exists t (id uuid primary key default gen_random_uuid(), team_id uuid not null references team(id) on delete cascade, s text default 'a' check (s in ('a','b')), code text unique, "order" int);`,
  `alter table t add column x int not null default 0, drop column y, alter column z type bigint, alter column z set not null, alter column w drop default, alter column v set default now();`,
  `alter table t add constraint k foreign key (a, b) references u (x, y) not valid; alter table t add constraint t_pkey primary key (id); alter table t drop constraint k;`,
  `alter table t rename column a to b; alter table t rename to u; create unique index i on u (a, lower(b)); drop index i; alter table u enable row level security;`,
  `begin; create index concurrently on u (a); drop trigger tr on u; comment on column u.a is 'it''s'; drop table u; commit;`,
];

describe("opsToSql", () => {
  it.each(CASES)("round-trips %#", async (sql) => {
    const ops = await opsOf(sql);
    expect(await opsOf(opsToSql(ops))).toEqual(ops);
  });

  it("emits llm-style colspecs as parseable sql", async () => {
    const sql = opsToSql([
      { op: "add_table", table: "refunds", columns: [{ name: "id", type: "uuid", pk: true }, { name: "user_id", type: "uuid", references: { table: "users", col: "id" } }] },
      { op: "set_enum", table: "refunds", column: "status", values: ["open", "done"] },
      { op: "data", table: "refunds", kind: "update" },
    ]);
    const ops = await opsOf(sql);
    expect(ops.map((o) => o.op)).toEqual(["add_table", "add_fk", "drop_constraint", "add_check"]);
  });

  it("emits a composite key as a table constraint", async () => {
    const ops = [{ op: "add_table" as const, table: "public.caps", columns: [{ name: "a", type: "uuid", pk: true }, { name: "b", type: "int", pk: true }, { name: "n", type: "int" }] }];
    const sql = opsToSql(ops);
    expect(sql.match(/PRIMARY KEY/g)).toHaveLength(1);
    const cols = (o: typeof ops) => applyOps(emptyModel(), o).tables["public.caps"].columns.map((c) => [c.name, !!c.pk, c.nullable]);
    expect(cols(await opsOf(sql) as typeof ops)).toEqual(cols(ops));
  });
});
