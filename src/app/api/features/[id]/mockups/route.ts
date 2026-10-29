import { NextResponse } from "next/server";
import { captureUrl } from "@/lib/capture";
import { planSketch, type SketchMockup } from "@/lib/sketch";
import { findPiece, pieceIdFrom, pieceView, withPiece } from "@/lib/pieces";
import { appBase } from "@/lib/stack";
import { getFeature, getSettings, id, now, updateFeature } from "@/lib/store";
import { viewportOf } from "@/lib/viewports";

type Ctx = { params: Promise<{ id: string }> };

export const maxDuration = 300;

// POST {url? | path?, accountId?, intent?, pieceId?, viewport?} -> pieceView. Capture the real page; sketch if intent given.
export async function POST(req: Request, { params }: Ctx) {
  const featureId = (await params).id;
  const stored = getFeature(featureId);
  if (!stored) return NextResponse.json({ error: "feature not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { url?: string; path?: string; accountId?: string; intent?: string; pieceId?: string; viewport?: string };
  const pid = pieceIdFrom(req.url, body);
  if (pid && !findPiece(stored, pid)) return NextResponse.json({ error: "piece not found" }, { status: 404 });
  const feature = pieceView(stored, pid);
  // a bare path lands on lambda's own stack (started / awaited when its plan is approved; else the configured
  // app url). A full url is taken as typed.
  const settings = getSettings();
  let base = settings.frontendUrl;
  if (!body.url?.trim()) {
    try {
      base = await appBase(settings);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
    }
  }
  let url: string;
  try {
    url = new URL(body.url?.trim() || body.path?.trim() || "/", base).href;
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error();
  } catch {
    return NextResponse.json({ error: "bad url" }, { status: 400 });
  }

  try {
    const { width, height } = viewportOf(body.viewport);
    const cap = await captureUrl({ url, accountId: body.accountId || undefined, viewport: { width, height } });
    const intent = body.intent?.trim().slice(0, 600) || undefined;
    const mockup: SketchMockup = {
      id: id("mk"),
      url: cap.url,
      title: cap.title,
      shot: cap.shot,
      thumb: cap.thumb,
      width: cap.width,
      height: cap.height,
      fold: cap.fold,
      elements: cap.elements,
      annotations: [],
      createdAt: now(),
      intent,
    };
    let sketchError = "";
    if (intent)
      mockup.annotations = await planSketch(feature, mockup, intent).catch((e: Error) => {
        sketchError = e.message.split("\n")[0].slice(0, 200);
        return [];
      });
    const f = pieceView(await updateFeature(featureId, (f) => withPiece(f, pid, (v) => void v.mockups.unshift(mockup))), pid);
    // capture is kept even if the model failed; the ui shows the header as a soft error
    return NextResponse.json(f, sketchError ? { headers: { "x-sketch-error": encodeURIComponent(sketchError) } } : undefined);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.split("\n")[0].slice(0, 200) }, { status: 502 });
  }
}
