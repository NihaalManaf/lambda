import { NextResponse } from "next/server";
import { listFeatures } from "@/lib/store";
import { TERMINAL, type Run } from "@/lib/runs";
import { reapIfLost } from "@/lib/verify";

// Live verification runs across every feature — tiny payload for the dock badge + notifications.
export async function GET() {
  const active = [];
  for (const f of listFeatures()) {
    for (const r of f.runs as Run[]) {
      if (TERMINAL.has(r.status)) continue;
      const run = await reapIfLost(f.id, r);
      if (TERMINAL.has(run.status)) continue;
      active.push({ id: run.id, featureId: f.id, status: run.status });
    }
  }
  return NextResponse.json({ active });
}
