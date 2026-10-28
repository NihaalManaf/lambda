import { NextResponse } from "next/server";
import { getFeature, updateFeature } from "@/lib/store";
import { resizeStories } from "@/lib/stories";

type Ctx = { params: Promise<{ id: string }> };

// POST {} -> re-run sizing only; existing stories are reassigned to new slices.
export async function POST(_: Request, { params }: Ctx) {
  const fid = (await params).id;
  const f0 = getFeature(fid);
  if (!f0) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const sizing = await resizeStories(f0); // mutates f0.stories[].sliceId
    const sliceOf = new Map(f0.stories.map((s) => [s.id, s.sliceId]));
    return NextResponse.json(
      await updateFeature(fid, (f) => {
        f.sizing = sizing;
        for (const s of f.stories) s.sliceId = sliceOf.get(s.id) ?? sizing.slices[0]?.id;
        for (const sl of sizing.slices) sl.storyIds = f.stories.filter((s) => s.sliceId === sl.id).map((s) => s.id);
      }),
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
