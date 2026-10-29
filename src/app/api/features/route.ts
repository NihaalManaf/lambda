import { NextResponse } from "next/server";
import { sweepStale } from "@/lib/jobs";
import { createFeature, listFeatures } from "@/lib/store";

export const runtime = "nodejs";

export async function GET() {
  await sweepStale();
  return NextResponse.json(listFeatures());
}

// Creating a feature opens the intake conversation (phase "intake"): nothing generates until the brief
// settles (jobs.startShaping). GET returns stored features (pieces, no projection).
export async function POST(req: Request) {
  const { title, brief } = ((await req.json().catch(() => ({}))) ?? {}) as { title?: string; brief?: string };
  if (!title?.trim()) return NextResponse.json({ error: "title required" }, { status: 400 });
  return NextResponse.json(await createFeature(title.trim().slice(0, 200), (brief ?? "").trim().slice(0, 4000)));
}
