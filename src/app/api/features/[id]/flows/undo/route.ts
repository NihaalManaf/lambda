import { NextResponse } from "next/server";
import { undoChart, undoDepth } from "@/lib/flows";
import { pieceOfFlowSet, pieceView, withPiece } from "@/lib/pieces";
import { updateFeature } from "@/lib/store";
import type { ChangeNote } from "@/lib/ops";

type Ctx = { params: Promise<{ id: string }> };

// GET ?chart=a&chart=b -> {depths: {a: 2, b: 0}} (how many undos each chart has)
export async function GET(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const ids = new URL(req.url).searchParams.getAll("chart");
  return NextResponse.json({ depths: Object.fromEntries(ids.map((c) => [c, undoDepth(fid, c)])) });
}

// POST {setId, chartId} -> {feature: pieceView, notes} (same shape as the ops route)
export async function POST(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const { setId, chartId } = (await req.json()) as { setId?: string; chartId?: string };
  if (!setId || !chartId) return NextResponse.json({ error: "setId + chartId required" }, { status: 400 });
  try {
    let note: ChangeNote | undefined;
    let pid: string | undefined;
    const feature = await updateFeature(fid, (f) => {
      pid = pieceOfFlowSet(f, setId)?.id;
      if (!pid) throw new Error("flow set not found");
      withPiece(f, pid, (v) => void (note = { ...undoChart(v, setId, chartId), piece: pid }));
    });
    return NextResponse.json({ feature: pieceView(feature, pid), notes: note ? [note] : [] });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "undo failed" }, { status: 409 });
  }
}
