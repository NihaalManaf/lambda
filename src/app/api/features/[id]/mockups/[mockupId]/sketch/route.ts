import { NextResponse } from "next/server";
import { planSketch, type SketchMockup } from "@/lib/sketch";
import { pieceOfMockup, pieceView } from "@/lib/pieces";
import { getFeature, updateFeature } from "@/lib/store";

type Ctx = { params: Promise<{ id: string; mockupId: string }> };

export const maxDuration = 300;

// POST {intent} -> pieceView of the mockup's piece. Re-plan the marker annotations for one screenshot.
export async function POST(req: Request, { params }: Ctx) {
  const { id, mockupId } = await params;
  const stored = getFeature(id);
  const pid = stored && pieceOfMockup(stored, mockupId)?.id;
  const feature = stored && pid ? pieceView(stored, pid) : undefined;
  const mockup = feature?.mockups.find((m) => m.id === mockupId) as SketchMockup | undefined;
  if (!feature || !mockup) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { intent?: string };
  const intent = body.intent?.trim().slice(0, 600) || mockup.intent || "";
  try {
    const annotations = await planSketch(feature, mockup, intent);
    const f = await updateFeature(id, (f) => {
      const m = pieceOfMockup(f, mockupId)?.mockups.find((m) => m.id === mockupId) as SketchMockup | undefined;
      if (!m) return;
      m.annotations = annotations;
      if (m.auto) m.edited = true; // re-sketched by hand: the auto job's re-runs keep it
      m.intent = intent || undefined;
    });
    return NextResponse.json(pieceView(f, pid));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
}
