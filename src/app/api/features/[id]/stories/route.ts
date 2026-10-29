import { NextResponse } from "next/server";
import { pieceIdFrom, pieceOfStory, pieceView, withPiece } from "@/lib/pieces";
import { getFeature, id, updateFeature } from "@/lib/store";
import { startJobs, sweepStale } from "@/lib/jobs";
import type { Story } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

const fail = (e: unknown, status = 500) =>
  NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });

// All take ?piece= or body.pieceId (default: first piece) and return that piece's view.
// POST {} -> (re)generate the piece's stories as a background job: the code is read first when the piece has
// no facts, and the result is checked against it after (src/lib/jobs.ts); the view comes back with the jobs
// queued. POST {story} -> add one manual story.
export async function POST(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const body = (await req.json().catch(() => ({}))) as { story?: Partial<Story>; pieceId?: string };
  const pid = pieceIdFrom(req.url, body);
  try {
    if (body.story) {
      const s = body.story;
      const story: Story = {
        id: id("st"),
        role: s.role ?? "user",
        want: s.want ?? "",
        soThat: s.soThat ?? "",
        priority: s.priority ?? "should",
        acceptance: (s.acceptance ?? []).map((a) => ({ ...a, id: a.id || id("ac") })),
        status: "todo",
      };
      const f = await updateFeature(fid, (f) => withPiece(f, pid, (v) => void v.stories.push(story)));
      return NextResponse.json(pieceView(f, pid));
    }
    const f0 = getFeature(fid);
    if (!f0) return fail("not found", 404);
    if (pid && !f0.pieces.some((p) => p.id === pid)) return fail("piece not found", 404);
    await sweepStale(fid);
    const f = await startJobs(fid, ["stories"], pid);
    return NextResponse.json(pieceView(f, pid));
  } catch (e) {
    return fail(e);
  }
}

// PATCH {storyId, patch} -> edit one story (found in whichever piece holds it).
export async function PATCH(req: Request, { params }: Ctx) {
  const { storyId, patch } = (await req.json()) as { storyId: string; patch: Partial<Story> };
  try {
    let pid: string | undefined;
    const f = await updateFeature((await params).id, (f) => {
      const p = pieceOfStory(f, storyId);
      const s = p?.stories.find((x) => x.id === storyId);
      if (!p || !s) throw new Error(`story ${storyId} not found`);
      pid = p.id;
      const { id: _ignore, acceptance, ...rest } = patch;
      void _ignore;
      Object.assign(s, rest);
      if (acceptance) s.acceptance = acceptance.map((a) => ({ ...a, id: a.id || id("ac") }));
    });
    return NextResponse.json(pieceView(f, pid));
  } catch (e) {
    return fail(e, 400);
  }
}

// DELETE ?storyId= -> remove one story.
export async function DELETE(req: Request, { params }: Ctx) {
  const storyId = new URL(req.url).searchParams.get("storyId");
  if (!storyId) return fail("storyId required", 400);
  try {
    let pid: string | undefined;
    const f = await updateFeature((await params).id, (f) => {
      const p = pieceOfStory(f, storyId);
      if (!p) return;
      pid = p.id;
      p.stories = p.stories.filter((s) => s.id !== storyId);
    });
    return NextResponse.json(pieceView(f, pid ?? pieceIdFrom(req.url)));
  } catch (e) {
    return fail(e, 400);
  }
}
