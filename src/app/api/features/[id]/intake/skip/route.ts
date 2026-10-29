import { NextResponse } from "next/server";
import { skipIntake } from "@/lib/intake";
import { pieceView } from "@/lib/pieces";
import { getFeature } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };

// POST -> pieceView of the feature, now shaping (brief synthesized from title / notes / what was said)
export async function POST(_: Request, { params }: Ctx) {
  const fid = (await params).id;
  const f = getFeature(fid);
  if (!f) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (f.phase !== "intake") return NextResponse.json(pieceView(f));
  try {
    return NextResponse.json(pieceView(await skipIntake(fid)));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
  }
}
