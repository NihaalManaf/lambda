import { describe, expect, it } from "vitest";
import type { ErdCol, ErdGraph, ErdTable } from "@/lib/schema/types";
import type { Risk } from "@/lib/types";
import { riskNumbers } from "@/components/viz/risk";
import { HEAD_H, NODE_W, OVERFLOW_ID, ROW_H, layoutErd, visibleRows } from "./erdLayout";

const col = (name: string, o: Partial<ErdCol> = {}): ErdCol => ({
  name,
  type: "text",
  fullType: "text",
  required: false,
  pk: false,
  fk: false,
  unique: false,
  indexed: false,
  diff: "same",
  pinned: false,
  ...o,
});
const table = (id: string, cols: ErdCol[], o: Partial<ErdTable> = {}): ErdTable => ({
  id,
  label: id.replace("public.", ""),
  diff: "same",
  origin: "migration",
  rls: false,
  badges: [],
  cols,
  riskIds: [],
  ...o,
});
const risk = (id: string, level: Risk["level"]): Risk => ({ id, rule: id, level, label: id, why: id, target: { kind: "table", id: "x" } });

const users = table("public.users", [col("id", { pk: true, pinned: true }), col("email"), col("name")]);
const refunds = table(
  "public.refund_requests",
  [
    col("id", { pk: true, pinned: true }),
    col("user_id", { fk: true, pinned: true }),
    col("status", { pinned: true, diff: "added", enumValues: [{ v: "open", diff: "added" }] }),
  ],
  { diff: "added", riskIds: ["r1", "r2"] },
);
const g: ErdGraph = {
  tables: [refunds, users],
  edges: [{ id: "e1", from: refunds.id, fromCol: "user_id", to: users.id, toCol: "id", diff: "added", cascade: true }],
  overflow: ["public.a", "public.b"],
  risks: [risk("r2", "info"), risk("r1", "bad")],
};

describe("erdLayout", () => {
  it("collapses to pinned cols with a fold row", () => {
    expect(visibleRows(users, false)).toMatchObject({ hidden: 2, fold: true });
    expect(visibleRows(users, true).rows).toHaveLength(3);
    expect(visibleRows({ ...users, diff: "context" }, false).fold).toBe(false);
  });

  it("sizes nodes by rows + enum rows, fk child left of parent", () => {
    const l = layoutErd(g, new Set(), riskNumbers(g.risks));
    const r = l.nodes.find((n) => n.id === refunds.id)!;
    const u = l.nodes.find((n) => n.id === users.id)!;
    expect(r.width).toBe(NODE_W);
    expect(r.height).toBe(HEAD_H + ROW_H * 4 + 4); // 3 cols + 1 enum row, no fold
    expect(u.height).toBe(HEAD_H + ROW_H * 2 + 4); // pk + fold
    expect(r.position.x).toBeLessThan(u.position.x);
    expect(l.nodes.some((n) => n.id === OVERFLOW_ID)).toBe(true);
  });

  it("hooks edges to column rows, falls back to header, numbers pins bad-first", () => {
    const l = layoutErd(g, new Set(), riskNumbers(g.risks));
    expect(l.edges[0]).toMatchObject({ sourceHandle: "user_id:s", targetHandle: "id:t", type: "fk", data: { cascade: true } });
    const hiddenCol = layoutErd({ ...g, edges: [{ ...g.edges[0], toCol: "email" }] }, new Set(), new Map());
    expect(hiddenCol.edges[0].targetHandle).toBe(":t");
    const pins = (l.nodes.find((n) => n.id === refunds.id)!.data as { pins: { id: string; n: number }[] }).pins;
    expect(pins).toEqual([
      { id: "r1", n: 1 },
      { id: "r2", n: 2 },
    ]);
  });
});
