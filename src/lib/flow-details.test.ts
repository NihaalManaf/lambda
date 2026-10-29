import { describe, expect, it, vi } from "vitest";
import { nodeDescription } from "@/components/flow/descriptions";
import { sanitizeChart, splitChart } from "./flows";

vi.mock("./llm", () => ({ generate: vi.fn(), featurePrompt: vi.fn() }));

const raw = {
  title: "sync billing",
  summary: "rebuild plans",
  nodes: [{ id: "n1", label: "sync triggered", kind: "start" as const, description: "Fetches subscriptions and rebuilds stored billing plans." }],
  edges: [],
  edgeCases: [],
  schedules: [{ nodeId: "n1", job: "billing sync", timing: "daily at 09:00", expression: "0 9 * * *", timezone: "UTC", source: "api/cron/jobs/billing.py:12" }],
};

describe("flow descriptions and schedules", () => {
  it("preserves full explanations and schedule details", () => {
    const chart = sanitizeChart(raw, "data");
    const text = nodeDescription(chart.nodes[0], chart);
    expect(text).toContain(raw.nodes[0].description);
    expect(text).toContain("daily at 09:00 (UTC)");
    expect(text).toContain("0 9 * * *");
    expect(text).toContain("api/cron/jobs/billing.py:12");
  });

  it("supports old diagrams without inventing explanations or timezones", () => {
    const chart = sanitizeChart({ ...raw, schedules: undefined, nodes: [{ id: "n1", label: "sync", kind: "start" }] }, "infra");
    expect(nodeDescription(chart.nodes[0], chart)).toContain("Redraw for a code-specific explanation");
    chart.schedules = [{ ...raw.schedules[0], timezone: null }];
    expect(nodeDescription(chart.nodes[0], chart)).toContain("timezone not specified");
  });

  it("drops schedules referring to missing nodes", () => {
    expect(sanitizeChart({ ...raw, schedules: [{ ...raw.schedules[0], nodeId: "missing" }] }, "data").schedules).toEqual([]);
  });

  it("keeps schedules only in the split containing the trigger", () => {
    const chart = sanitizeChart({
      ...raw,
      nodes: Array.from({ length: 20 }, (_, i) => ({ id: `n${i + 1}`, label: `step ${i}`, kind: "step" as const })),
      edges: Array.from({ length: 19 }, (_, i) => ({ from: `n${i + 1}`, to: `n${i + 2}`, label: null })),
    }, "infra");
    const parts = splitChart(chart);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flatMap((p) => p.schedules ?? [])).toHaveLength(1);
    for (const part of parts) {
      for (const schedule of part.schedules ?? []) expect(part.nodes.some((n) => n.id === schedule.nodeId)).toBe(true);
    }
  });
});
