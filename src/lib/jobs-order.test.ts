import { describe, expect, it } from "vitest";
import { JOB_KINDS, pieceKindsFor, sequencePiece } from "./jobs";
import { makePiece } from "./pieces";
import type { Feature, PieceFacts, PieceJobKind } from "./types";

const facts = (sha = "a".repeat(40), incomplete?: string): PieceFacts => ({
  routes: [], endpoints: [], tables: [], gates: [], components: [], notes: [], appRoutes: [], sha, at: "", ...(incomplete ? { incomplete } : {}),
});
const feature = (baseSha?: string): Feature => ({
  id: "f", title: "t", brief: "", phase: "ready", status: "shaping", createdAt: "", updatedAt: "", context: [], pieces: [],
  ...(baseSha ? { intake: { status: "idle", baseSha } } : {}),
});

describe("piece kinds for a run", () => {
  it("stories / flows read the code first when facts are missing or stale, and are checked after", () => {
    const p = makePiece({ title: "one" });
    expect(pieceKindsFor(feature(), p, ["stories"])).toEqual(["facts", "stories", "check"]);
    p.facts = facts();
    expect(pieceKindsFor(feature(), p, ["stories"])).toEqual(["stories", "check"]);
    expect(pieceKindsFor(feature("b".repeat(40)), p, ["flows"])).toEqual(["facts", "flows", "check"]); // pin moved
    p.facts = facts(undefined, "timed out");
    expect(pieceKindsFor(feature(), p, ["stories", "flows"])).toEqual(["facts", "stories", "flows", "check"]);
  });

  it("other kinds (and an explicit retry) stay as asked", () => {
    const p = makePiece({ title: "one" });
    expect(pieceKindsFor(feature(), p, ["schema", "queues"])).toEqual(["schema", "queues"]);
    expect(pieceKindsFor(feature(), p, ["check"])).toEqual(["check"]);
    expect(pieceKindsFor(feature(), p, ["facts"])).toEqual(["facts"]);
    expect(JOB_KINDS).toEqual(expect.arrayContaining(["facts", "check"]));
  });
});

describe("re-reading the code of a piece with artifacts", () => {
  it("checks them again", () => {
    const p = makePiece({ title: "one" });
    p.stories = [{ id: "s1", role: "host", want: "x", soThat: "y", priority: "must", status: "todo", acceptance: [] }];
    expect(pieceKindsFor(feature(), p, ["facts"])).toEqual(["facts", "check"]);
    expect(pieceKindsFor(feature(), p, ["facts", "stories"])).toEqual(["facts", "stories", "check"]);
  });
});

// stub jobs that log start / end, finishing after `ms`
function harness(ms: Partial<Record<PieceJobKind, number>> = {}) {
  const log: string[] = [];
  const settledCalls: string[] = [];
  const steps = {
    job: async (k: PieceJobKind) => {
      log.push(`start ${k}`);
      await new Promise((r) => setTimeout(r, ms[k] ?? 5));
      log.push(`end ${k}`);
    },
    settled: async (k: PieceJobKind, maxMs?: number) => void settledCalls.push(`${k}${maxMs ? `:${maxMs}` : ""}`),
  };
  return { log, settledCalls, steps };
}

describe("piece sequencing", () => {
  it("facts → stories ∥ flows ∥ needs → check; sketch after stories", async () => {
    const h = harness({ facts: 20, stories: 15, flows: 30, needs: 5, sketch: 1 });
    await sequencePiece(["facts", "stories", "flows", "needs", "sketch", "check"], h.steps);
    const at = (e: string) => h.log.indexOf(e);
    for (const k of ["stories", "flows", "needs"]) expect(at(`start ${k}`)).toBeGreaterThan(at("end facts"));
    expect(at("start sketch")).toBeGreaterThan(at("end stories"));
    expect(at("start sketch")).toBeLessThan(at("end flows")); // doesn't wait on check / flows
    for (const k of ["stories", "flows", "needs"]) expect(at("start check")).toBeGreaterThan(at(`end ${k}`));
    // writers elsewhere are waited on as long as a facts read (theirs runs first)
    expect(h.settledCalls).toEqual(expect.arrayContaining(["stories:1800000", "flows:1800000", "needs:1800000"]));
  });

  it("without a facts kind it waits on a facts job running elsewhere; a failing job never blocks", async () => {
    const h = harness();
    const steps = {
      ...h.steps,
      job: async (k: PieceJobKind) => {
        if (k === "stories") throw new Error("boom");
        return h.steps.job(k);
      },
    };
    await sequencePiece(["stories", "check"], steps);
    expect(h.settledCalls[0]).toBe("facts:1800000");
    expect(h.log).toEqual(["start check", "end check"]);
  });
});

describe("a check asked for again", () => {
  it("settles the writers again and runs once more; a flag set while waiting is folded into the first run", async () => {
    const h = harness({ check: 5 });
    let asks = 0;
    const flags = [false, true, false, false]; // [before 1st check, after 1st, before 2nd, after 2nd]
    await sequencePiece(["check"], { ...h.steps, again: () => flags[asks++] ?? false });
    expect(h.log).toEqual(["start check", "end check", "start check", "end check"]);
    expect(h.settledCalls.filter((k) => k.startsWith("stories"))).toHaveLength(2);
  });
});
