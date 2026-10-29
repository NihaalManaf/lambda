"use client";

import { createContext, useContext } from "react";
import type { FlowchartSet } from "@/lib/types";

// settings.edgeCases: false hides edge cases everywhere they render. Render-only: the stored charts keep
// theirs (tabs write views back, so never strip them from the feature itself).
export const EdgeCasesCtx = createContext(true);
export const useEdgeCases = () => useContext(EdgeCasesCtx);

export const withoutEdgeCases = (sets: FlowchartSet[]): FlowchartSet[] =>
  sets.map((s) => ({ ...s, charts: s.charts.map((c) => (c.edgeCases.length ? { ...c, edgeCases: [] } : c)) }));
