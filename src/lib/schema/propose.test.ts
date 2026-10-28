import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyOps, emptyModel } from "./apply";
import { EffectCache } from "./cache";
import { compact, relevantTables, toOp } from "./propose";
import { opsOf } from "./testutil";

vi.mock("../llm", () => ({ generate: vi.fn(), featurePrompt: () => "" }));

describe("propose helpers", () => {
  it("picks tables by brief tokens plus fk neighbours, renders compact lines", async () => {
    const m = applyOps(emptyModel(), await opsOf(`
      create table team (id uuid primary key, name text);
      create table refund_requests (id uuid primary key, team_id uuid references team(id), status text check (status in ('open','done')));
      create table podcasts (id uuid primary key);`));
    const ids = relevantTables(m, "staff can approve refunds");
    expect(ids).toEqual(["public.refund_requests", "public.team"]);
    expect(compact(m, ids)).toBe("refund_requests(id*:uuid, team_id:uuid->team, status:text[open|done])\nteam(id*:uuid, name:text)");
  });

  it("maps flat model ops, dropping ones missing fields", () => {
    const blank = { table: null, name: null, column: null, to: null, columns: null, col: null, type: null, nullable: null, default: null, cols: null, refTable: null, refCols: null, onDelete: null, values: null, unique: null, on: null, kind: null, note: null };
    expect(toOp({ ...blank, op: "set_enum", table: "refunds", column: "status", values: ["a"] })).toEqual({ op: "set_enum", table: "public.refunds", column: "status", values: ["a"] });
    expect(toOp({ ...blank, op: "add_column", table: "t" })).toBeNull();
    expect(toOp({ ...blank, op: "add_fk", table: "t", cols: ["u_id"], refTable: "users" })).toEqual({ op: "add_fk", table: "public.t", cols: ["u_id"], refTable: "public.users", refCols: ["id"] });
  });
});

describe("effect cache", () => {
  it("persists parse results keyed by content", () => {
    const file = `${fs.mkdtempSync(path.join(os.tmpdir(), "fx-"))}/e.json`;
    const a = new EffectCache(file);
    a.set(a.key("select 1"), { ops: [] });
    a.save();
    const b = new EffectCache(file);
    expect(b.get(b.key("select 1"))).toEqual({ ops: [] });
    expect(b.get(b.key("select 2"))).toBeUndefined();
  });
});
