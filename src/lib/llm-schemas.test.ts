import { describe, expect, it } from "vitest";
import { z } from "zod";
import { blanksToNull } from "./llm";
import { Out as QueueOut } from "./queues/propose";
import { Out as SchemaOut } from "./schema/propose";

// the API rejects structured-output schemas with > 16 union-typed (nullable / anyOf) params
const unions = (s: unknown): number => {
  if (!s || typeof s !== "object") return 0;
  const o = s as Record<string, unknown>;
  const own = Array.isArray(o.type) || Array.isArray(o.anyOf) ? 1 : 0;
  return own + Object.values(o).reduce<number>((n, v) => n + (Array.isArray(v) ? v.reduce<number>((m, x) => m + unions(x), 0) : unions(v)), 0);
};

describe("llm output schemas", () => {
  it("stay under the union-param limit", () => {
    for (const s of [SchemaOut, QueueOut]) expect(unions(z.toJSONSchema(s, { reused: "ref" }))).toBeLessThanOrEqual(16);
  });
  it("maps blanks back to null", () => {
    expect(blanksToNull({ a: "", b: [], c: "x", d: { e: "" }, f: [1], g: 0, h: false })).toEqual({ a: null, b: null, c: "x", d: { e: null }, f: [1], g: 0, h: false });
  });
});
