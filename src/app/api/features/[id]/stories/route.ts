import { NextResponse } from "next/server";
import { getFeature, id, updateFeature } from "@/lib/store";
import { generateStories, syncSlices } from "@/lib/stories";
import type { Story } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

const fail = (e: unknown, status = 500) =>
  NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });

// POST {} -> generate sizing + stories (replaces). POST {story} -> add one manual story.
export async function POST(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const body = (await req.json().catch(() => ({}))) as { story?: Partial<Story> };
  try {
    if (body.story) {
      const s = body.story;
      const story: Story = {
        id: id("st"),
        role: s.role ?? "user",
        want: s.want ?? "",
        soThat: s.soThat ?? "",
        priority: s.priority ?? "should",
        sliceId: s.sliceId,
        acceptance: (s.acceptance ?? []).map((a) => ({ ...a, id: a.id || id("ac") })),
        status: "todo",
      };
      return NextResponse.json(
        await updateFeature(fid, (f) => {
          f.stories.push(story);
          syncSlices(f);
        }),
      );
    }
    const f0 = getFeature(fid);
    if (!f0) return fail("not found", 404);
    const { sizing, stories } = await generateStories(f0); // slow: outside the lock
    return NextResponse.json(
      await updateFeature(fid, (f) => {
        f.sizing = sizing;
        f.stories = stories;
      }),
    );
  } catch (e) {
    return fail(e);
  }
}

// PATCH {storyId, patch} -> edit one story.
export async function PATCH(req: Request, { params }: Ctx) {
  const { storyId, patch } = (await req.json()) as { storyId: string; patch: Partial<Story> };
  try {
    return NextResponse.json(
      await updateFeature((await params).id, (f) => {
        const s = f.stories.find((x) => x.id === storyId);
        if (!s) throw new Error(`story ${storyId} not found`);
        const { id: _ignore, acceptance, ...rest } = patch;
        void _ignore;
        Object.assign(s, rest);
        if (acceptance) s.acceptance = acceptance.map((a) => ({ ...a, id: a.id || id("ac") }));
        syncSlices(f);
      }),
    );
  } catch (e) {
    return fail(e, 400);
  }
}

// DELETE ?storyId= -> remove one story.
export async function DELETE(req: Request, { params }: Ctx) {
  const storyId = new URL(req.url).searchParams.get("storyId");
  if (!storyId) return fail("storyId required", 400);
  try {
    return NextResponse.json(
      await updateFeature((await params).id, (f) => {
        f.stories = f.stories.filter((s) => s.id !== storyId);
        syncSlices(f);
      }),
    );
  } catch (e) {
    return fail(e, 400);
  }
}
