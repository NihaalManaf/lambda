import type { Flowchart, FlowNode, FlowSchedule } from "@/lib/types";

const meanings: Record<FlowNode["kind"], string> = {
  start: "The event or action that starts this flow.",
  step: "An action performed at this point in the flow.",
  decision: "A condition that chooses which labeled path to follow.",
  end: "The flow finishes here.",
  error: "A failure or error outcome in this flow.",
  external: "An interaction with an external service or system.",
  store: "A read or write involving stored data, such as a database, cache, or file.",
};

export function scheduleText(schedule: FlowSchedule): string {
  return `${schedule.job}: ${schedule.timing} (${schedule.timezone || "timezone not specified"})${schedule.expression ? ` · ${schedule.expression}` : ""}${schedule.source ? `\nSource: ${schedule.source}` : ""}`;
}

export function nodeDescription(node: FlowNode, chart: Flowchart): string {
  const explanation = node.description?.trim() || `${node.label}: ${meanings[node.kind]} Redraw for a code-specific explanation.`;
  const schedules = (chart.schedules ?? []).filter((s) => s.nodeId === node.id).map(scheduleText);
  return [explanation, ...schedules].join("\n\n");
}
