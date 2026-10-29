import { describe, expect, it } from "vitest";
import { z } from "zod";
import { blanksToNull, featurePrompt, UNDERSTAND_LINE } from "./llm";
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
  it("featurePrompt: build unchanged, understand reframed as-is", () => {
    const base = { title: "invites", brief: "send invites", context: [], briefDoc: undefined };
    expect(featurePrompt(base)).toBe("feature: invites\n\nbrief:\nsend invites");
    const u = featurePrompt({ ...base, mode: "understand" });
    expect(u.startsWith(UNDERSTAND_LINE)).toBe(true);
    expect(u).toContain("existing feature: invites");
    const pieces = [
      { id: "a", order: 1, title: "entry", why: "" },
      { id: "b", order: 2, title: "data", why: "" },
    ];
    expect(featurePrompt({ ...base, pieces, pieceId: "a" })).toContain("its own PR");
    const up = featurePrompt({ ...base, pieces, pieceId: "a", mode: "understand" });
    expect(up).toContain("sub-area 1 of 2");
    expect(up).not.toContain("PR");
  });
  it("maps blanks back to null", () => {
    expect(blanksToNull({ a: "", b: [], c: "x", d: { e: "" }, f: [1], g: 0, h: false })).toEqual({ a: null, b: null, c: "x", d: { e: null }, f: [1], g: 0, h: false });
  });
});
