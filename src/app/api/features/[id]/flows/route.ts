import { NextResponse } from "next/server";
import { generateFlows } from "@/lib/flows";
import { findPiece, pieceIdFrom, pieceOfFlowSet, pieceView, withPiece } from "@/lib/pieces";
import { getFeature, updateFeature } from "@/lib/store";
import type { FlowLens } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

const LENSES: FlowLens[] = ["customer-journey", "data", "infra", "state", "custom"];
const err = (error: string, status = 400) => NextResponse.json({ error }, { status });

export const maxDuration = 300;

// POST {lens, focus?, pieceId?} -> pieceView with a new flowchart set appended to that piece (default: first).
export async function POST(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const body = (await req.json().catch(() => ({}))) as { lens?: FlowLens; focus?: string; pieceId?: string };
  const { lens, focus } = body;
  const pid = pieceIdFrom(req.url, body);
  if (!lens || !LENSES.includes(lens)) return err("bad lens");
  if (lens === "custom" && !focus?.trim()) return err("custom lens needs a focus");
  const feature = getFeature(fid);
  if (!feature) return err("not found", 404);
  if (pid && !findPiece(feature, pid)) return err("piece not found", 404);
  try {
    const set = await generateFlows(pieceView(feature, pid), lens, focus);
    const f = await updateFeature(fid, (f) => withPiece(f, pid, (v) => void v.flowcharts.push(set)));
    return NextResponse.json(pieceView(f, pid));
  } catch (e) {
    return err(e instanceof Error ? e.message : "generation failed", 502);
  }
}

// PATCH {setId, chartId, edgeCaseId, handled} -> pieceView of the piece holding the set (edge case decision).
export async function PATCH(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const b = (await req.json()) as { setId: string; chartId: string; edgeCaseId: string; handled: boolean | null };
  if (![true, false, null].includes(b.handled)) return err("handled must be true/false/null");
  try {
    let pid: string | undefined;
    const f = await updateFeature(fid, (f) => {
      const p = pieceOfFlowSet(f, b.setId);
      pid = p?.id;
      const ec = p?.flowcharts
        .find((s) => s.id === b.setId)
        ?.charts.find((c) => c.id === b.chartId)
        ?.edgeCases.find((e) => e.id === b.edgeCaseId);
      if (!ec) throw new Error("edge case not found");
      ec.handled = b.handled;
    });
    return NextResponse.json(pieceView(f, pid));
  } catch (e) {
    return err(e instanceof Error ? e.message : "update failed", 404);
  }
}

// DELETE ?setId= -> pieceView
export async function DELETE(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const setId = new URL(req.url).searchParams.get("setId");
  if (!setId) return err("setId required");
  try {
    let pid = pieceIdFrom(req.url);
    const f = await updateFeature(fid, (f) => {
      const p = pieceOfFlowSet(f, setId);
      if (!p) return;
      pid = p.id;
      p.flowcharts = p.flowcharts.filter((s) => s.id !== setId);
    });
    return NextResponse.json(pieceView(f, pid));
  } catch (e) {
    return err(e instanceof Error ? e.message : "delete failed", 404);
  }
}
