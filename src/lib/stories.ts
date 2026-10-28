import "server-only";
import { z } from "zod";
import { featurePrompt, generate } from "./llm";
import { id } from "./store";
import type { Acceptance, Feature, Sizing, Slice, Story } from "./types";
import type { ChangeNote, StoryOp } from "./ops";
import { applyStoryOpWith, syncSlicesPure } from "./stories-apply";

// User stories (NUS CS2103 style) + sizing/splitting into sequential vertical slices.

const RULES = `
user stories: "as a <role>, i can <want>, so that <benefit>". stories are conversation starters, not specs.
- role: 1-3 words (e.g. "host", "new user", "admin").
- want: <= 10 words, starts with a verb. soThat: <= 10 words.
- priority: must (core, ship blocker) / should / could.
- 1-3 acceptance criteria per story, each BROWSER-VERIFIABLE against the running web app:
  given/when/then <= 8 words each; startPath is a real route ("/campaigns");
  steps: 2-6 concrete browser actions, each <= 12 words, e.g. "click 'new campaign'", "fill 'name' with 'q3 launch'", "expect toast 'saved'".
sizing:
- recommend "split" when > ~6 stories, multiple user roles, or multiple surfaces; else "one-piece".
- slices are VERTICAL: each shippable + browser-verifiable alone, ordered to build sequentially (foundation first).
- one-piece => exactly 1 slice. split => 2-5 slices. slice title <= 6 words, why <= 15 words. reason <= 20 words.
- every story references a slice by its 0-based index.
`.trim();

const AcceptanceZ = z.object({
  given: z.string(),
  when: z.string(),
  then: z.string(),
  startPath: z.string(),
  steps: z.array(z.string()),
});

const SliceZ = z.object({ title: z.string(), why: z.string() });

const SizingZ = z.object({
  verdict: z.enum(["one-piece", "split"]),
  reason: z.string(),
  slices: z.array(SliceZ),
});

const StoriesOut = z.object({
  sizing: SizingZ,
  stories: z.array(
    z.object({
      role: z.string(),
      want: z.string(),
      soThat: z.string(),
      priority: z.enum(["must", "should", "could"]),
      slice: z.number().int(),
      acceptance: z.array(AcceptanceZ),
    }),
  ),
});

const SizingOut = z.object({
  sizing: SizingZ,
  storySlice: z.array(z.object({ storyIndex: z.number().int(), slice: z.number().int() })),
});

const clampIdx = (i: number, n: number) => Math.min(Math.max(0, Math.round(i)), Math.max(0, n - 1));

export const toAcceptance = (a: z.infer<typeof AcceptanceZ>): Acceptance => ({
  id: id("ac"),
  ...a,
  startPath: a.startPath.startsWith("/") ? a.startPath : `/${a.startPath}`,
  steps: a.steps.slice(0, 8),
});

// Build Sizing from model slices, filling storyIds from each story's sliceId.
function buildSizing(raw: z.infer<typeof SizingZ>, stories: Story[], sliceOf: (s: Story, i: number) => number): Sizing {
  const slices: Slice[] = (raw.slices.length ? raw.slices : [{ title: "whole feature", why: "small enough to ship once" }]).map(
    (s) => ({ id: id("sl"), title: s.title, why: s.why, storyIds: [] }),
  );
  stories.forEach((st, i) => {
    const sl = slices[clampIdx(sliceOf(st, i), slices.length)];
    st.sliceId = sl.id;
    sl.storyIds.push(st.id);
  });
  return { verdict: slices.length > 1 ? raw.verdict : "one-piece", reason: raw.reason, slices };
}

export async function generateStories(feature: Feature): Promise<{ sizing: Sizing; stories: Story[] }> {
  const out = await generate({
    schema: StoriesOut,
    system: RULES,
    prompt: `${featurePrompt(feature)}\n\nwrite the user stories + sizing for this feature.`,
    maxTokens: 12000,
  });
  const stories: Story[] = out.stories.map((s) => ({
    id: id("st"),
    role: s.role,
    want: s.want,
    soThat: s.soThat,
    priority: s.priority,
    acceptance: s.acceptance.slice(0, 3).map(toAcceptance),
    status: "todo",
  }));
  const sizing = buildSizing(out.sizing, stories, (_, i) => out.stories[i].slice);
  return { sizing, stories };
}

// Re-run sizing only, keeping existing stories (mutates their sliceId).
export async function resizeStories(feature: Feature): Promise<Sizing> {
  const list = feature.stories.map((s, i) => `${i}. [${s.priority}] as a ${s.role}, i can ${s.want}, so that ${s.soThat}`);
  const out = await generate({
    schema: SizingOut,
    system: RULES,
    prompt: `${featurePrompt(feature)}\n\nexisting stories:\n${list.join("\n") || "(none)"}\n\nsize this feature and assign every story index to a slice.`,
    effort: "low",
  });
  const map = new Map(out.storySlice.map((x) => [x.storyIndex, x.slice]));
  return buildSizing(out.sizing, feature.stories, (_, i) => map.get(i) ?? 0);
}

// Keep sizing.slices[].storyIds consistent with story.sliceId after edits.
export const syncSlices = (f: Feature) => syncSlicesPure(f);

// Edit contract (src/lib/ops.ts): apply one StoryOp in place — call inside updateFeature.
// The reducer is pure + shared with the board's optimistic updates (src/lib/stories-apply.ts).
export function applyStoryOp(feature: Feature, op: StoryOp): ChangeNote {
  return applyStoryOpWith(feature, op, id);
}
