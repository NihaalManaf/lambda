import { describe, expect, it } from "vitest";
import type { QueueGraph } from "@/lib/queues/types";
import { humanCron, layoutQueue, shortLabel } from "./queueLayout";

describe("humanCron", () => {
  it.each([
    ["0 1 * * *", "daily 1am"],
    ["30 13 * * *", "daily 1:30pm"],
    ["*/5 * * * *", "every 5m"],
    ["* * * * *", "every minute"],
    ["15 * * * *", "hourly"],
    ["0 */6 * * *", "every 6h"],
    ["0 9 * * 1-5", "weekdays 9am"],
    ["0 0 * * 1", "mon 12am"],
    ["0 12 1 * *", "monthly 12pm"],
    ["0 9 1 1 *", "0 9 1 1 *"],
  ])("%s → %s", (c, out) => expect(humanCron(c)).toBe(out));
});

const node = (id: string, kind: QueueGraph["nodes"][number]["kind"], label = id, riskIds: string[] = []) => ({
  id,
  kind,
  sub: kind === "trigger" ? "0 1 * * *" : "py",
  label,
  diff: "same" as const,
  badges: [],
  riskIds,
});

describe("layoutQueue", () => {
  const g: QueueGraph = {
    title: "t",
    nodes: [node("t", "trigger"), node("p", "producer"), node("c", "channel", "/v1/draft/journo_v2"), node("k", "consumer", "k", ["r1", "r2"])],
    edges: [
      { id: "e1", from: "t", to: "p", role: "schedule", badges: [], diff: "same", dots: 1, speed: 2.5, retry: false },
      { id: "e2", from: "p", to: "c", role: "publish", badges: [], diff: "added", dots: 2, speed: 1, retry: true },
      { id: "e3", from: "c", to: "k", role: "deliver", badges: [], diff: "same", dots: 1, speed: 1, retry: false },
      { id: "e4", from: "p", to: "p", role: "loop", badges: [], diff: "same", dots: 1, speed: 1, retry: false },
      { id: "e5", from: "p", to: "ghost", role: "publish", badges: [], diff: "same", dots: 1, speed: 1, retry: false },
    ],
    risks: [
      { id: "r1", rule: "x", level: "info", label: "a", why: "", target: { kind: "node", id: "k" } },
      { id: "r2", rule: "y", level: "bad", label: "b", why: "", target: { kind: "node", id: "k" } },
    ],
  };

  it("lays out left to right, keeps self-loops, drops dangling edges", () => {
    const { nodes, edges } = layoutQueue(g);
    const x = (id: string) => nodes.find((n) => n.id === id)!.position.x;
    expect(x("t")).toBeLessThan(x("p"));
    expect(x("p")).toBeLessThan(x("c"));
    expect(x("c")).toBeLessThan(x("k"));
    expect(edges.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(edges.every((e) => e.type === "message")).toBe(true);
  });

  it("numbers pins in RiskList order (bad first) and takes the worst level", () => {
    const k = layoutQueue(g).nodes.find((n) => n.id === "k")!;
    expect(k.data.pins.map((p) => [p.id, p.n])).toEqual([
      ["r2", 1],
      ["r1", 2],
    ]);
    expect(k.data.worst).toBe("bad");
  });

  it("shortens channel labels to the last two path segments", () => {
    expect(shortLabel(node("c", "channel", "/v1/draft/journo_v2"))).toBe("draft/journo_v2");
    expect(shortLabel(node("p", "producer", "a/b/c"))).toBe("a/b/c");
  });
});
