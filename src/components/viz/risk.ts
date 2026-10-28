import type { Risk, RiskLevel } from "@/lib/types";

// Shared risk ordering: canvas pins and the RiskList number risks the same way.

const RANK: Record<RiskLevel, number> = { bad: 0, warn: 1, info: 2 };

// level first, then same-label risks kept together so a merged row's pins are a run of numbers
export const orderRisks = (risks: Risk[]) => {
  const first = new Map<string, number>();
  risks.forEach((r, i) => first.has(r.label) || first.set(r.label, i));
  return [...risks].sort((a, b) => RANK[a.level] - RANK[b.level] || first.get(a.label)! - first.get(b.label)!);
};

/** one RiskList row per (level, label): many "unthrottled fan-out"s read as one chip ×N */
export function groupRisks(ordered: Risk[]): Risk[][] {
  const by = new Map<string, Risk[]>();
  for (const r of ordered) {
    const k = `${r.level}|${r.label}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(r);
  }
  return [...by.values()];
}

// hovering a merged row lights every one of its pins: the hover key carries all their ids
const SEP = "\u0001";
export const hoverKey = (ids: string[]) => ids.join(SEP);
export const hovers = (hover: string | null | undefined, id: string) => !!hover && (hover === id || hover.split(SEP).includes(id));

/** risk id → 1-based pin number, in RiskList order */
export const riskNumbers = (risks: Risk[]) => new Map(orderRisks(risks).map((r, i) => [r.id, i + 1]));

/** "good news" info risks (safety check, poison handled) read as ok, not as a warning */
export const isOk = (r: Risk) => r.level === "info" && /guard|safety|poison/i.test(`${r.rule} ${r.label}`);

export const riskColor = (r: Risk) =>
  isOk(r) ? "var(--ok)" : r.level === "bad" ? "var(--bad)" : r.level === "warn" ? "var(--warn)" : "var(--blue)";
