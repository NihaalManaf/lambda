import { NextResponse } from "next/server";
import { generateFlows } from "@/lib/flows";
import { getFeature, updateFeature } from "@/lib/store";
import type { FlowLens } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

const LENSES: FlowLens[] = ["customer-journey", "data", "infra", "state", "custom"];
const err = (error: string, status = 400) => NextResponse.json({ error }, { status });

export const maxDuration = 300;

// POST {lens, focus?} -> Feature with a new flowchart set appended.
export async function POST(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const { lens, focus } = (await req.json()) as { lens?: FlowLens; focus?: string };
  if (!lens || !LENSES.includes(lens)) return err("bad lens");
  if (lens === "custom" && !focus?.trim()) return err("custom lens needs a focus");
  const feature = getFeature(fid);
  if (!feature) return err("not found", 404);
  try {
    const set = await generateFlows(feature, lens, focus);
    return NextResponse.json(await updateFeature(fid, (f) => void f.flowcharts.push(set)));
  } catch (e) {
    return err(e instanceof Error ? e.message : "generation failed", 502);
  }
}

// PATCH {setId, chartId, edgeCaseId, handled} -> Feature (edge case decision).
export async function PATCH(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const b = (await req.json()) as { setId: string; chartId: string; edgeCaseId: string; handled: boolean | null };
  if (![true, false, null].includes(b.handled)) return err("handled must be true/false/null");
  try {
    const f = await updateFeature(fid, (f) => {
      const ec = f.flowcharts
        .find((s) => s.id === b.setId)
        ?.charts.find((c) => c.id === b.chartId)
        ?.edgeCases.find((e) => e.id === b.edgeCaseId);
      if (!ec) throw new Error("edge case not found");
      ec.handled = b.handled;
    });
    return NextResponse.json(f);
  } catch (e) {
    return err(e instanceof Error ? e.message : "update failed", 404);
  }
}

// DELETE ?setId= -> Feature
export async function DELETE(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const setId = new URL(req.url).searchParams.get("setId");
  if (!setId) return err("setId required");
  try {
    return NextResponse.json(await updateFeature(fid, (f) => void (f.flowcharts = f.flowcharts.filter((s) => s.id !== setId))));
  } catch (e) {
    return err(e instanceof Error ? e.message : "delete failed", 404);
  }
}
