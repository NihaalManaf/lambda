import { NextResponse } from "next/server";
import { startJobs, sweepStale } from "@/lib/jobs";
import { createFeature, listFeatures } from "@/lib/store";

export const runtime = "nodejs";

export async function GET() {
  await sweepStale();
  return NextResponse.json(listFeatures());
}

// Creating a feature kicks off generation in the background (context → stories ∥ flows → schema/queues).
export async function POST(req: Request) {
  const { title, brief } = (await req.json()) as { title?: string; brief?: string };
  if (!title?.trim()) return NextResponse.json({ error: "title required" }, { status: 400 });
  const f = createFeature(title.trim(), (brief ?? "").trim());
  try {
    return NextResponse.json(await startJobs(f.id));
  } catch {
    return NextResponse.json(f); // generation can always be started from the workspace
  }
}
