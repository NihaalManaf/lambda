import { NextResponse } from "next/server";
import { planSketch, type SketchMockup } from "@/lib/sketch";
import { getFeature, updateFeature } from "@/lib/store";

type Ctx = { params: Promise<{ id: string; mockupId: string }> };

export const maxDuration = 300;

// POST {intent} -> Feature. Re-plan the marker annotations for one screenshot.
export async function POST(req: Request, { params }: Ctx) {
  const { id, mockupId } = await params;
  const feature = getFeature(id);
  const mockup = feature?.mockups.find((m) => m.id === mockupId) as SketchMockup | undefined;
  if (!feature || !mockup) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { intent?: string };
  const intent = body.intent?.trim().slice(0, 600) || mockup.intent || "";
  try {
    const annotations = await planSketch(feature, mockup, intent);
    const f = await updateFeature(id, (f) => {
      const m = f.mockups.find((m) => m.id === mockupId) as SketchMockup | undefined;
      if (!m) return;
      m.annotations = annotations;
      m.intent = intent || undefined;
    });
    return NextResponse.json(f);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
}
