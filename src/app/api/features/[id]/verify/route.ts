import { NextResponse } from "next/server";
import { getFeature } from "@/lib/store";
import { startRun } from "@/lib/verify";

type Ctx = { params: Promise<{ id: string }> };

// Start a browser verification run for one story.
export async function POST(req: Request, { params }: Ctx) {
  const f = getFeature((await params).id);
  if (!f) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { storyId?: string; accountId?: string };
  if (!body.storyId) return NextResponse.json({ error: "storyId required" }, { status: 400 });
  try {
    return NextResponse.json(await startRun(f, body.storyId, body.accountId || undefined));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
