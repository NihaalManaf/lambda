// shared helpers for schema tests (not imported by app code)
import { applyOps, cloneModel, emptyModel } from "./apply";
import { parseSql } from "./parse";
import { risk } from "./risk";
import type { SchemaModel } from "./types";

export const opsOf = async (sql: string) => {
  const r = await parseSql(sql);
  if (r.error) throw new Error(r.error.message);
  return r.ops;
};

export async function step(sql: string, seed = "", meta: { dupPrefix?: boolean; parseError?: string } = {}) {
  const before: SchemaModel = applyOps(emptyModel(), await opsOf(seed), "seed");
  const ops = await opsOf(sql);
  const after = applyOps(cloneModel(before), ops, "m");
  return { before, after, ops, risks: risk(ops, before, after, { id: "m", dupPrefix: !!meta.dupPrefix, parseError: meta.parseError }) };
}
