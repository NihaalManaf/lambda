import "server-only";
import { z } from "zod";
import { featurePrompt, generate } from "./llm";
import { id } from "./store";
import type { Acceptance, FeatureView, Story } from "./types";
import type { ChangeNote, StoryOp } from "./ops";
import { applyStoryOpWith } from "./stories-apply";

// User stories (NUS CS2103 style) for ONE piece (one PR). Pieces replaced sizing/slices: a piece's stories
// carry priorities only.

const RULES = `
user stories: "as a <role>, i can <want>, so that <benefit>". stories are conversation starters, not specs.
- role: 1-3 words (e.g. "host", "new user", "admin").
- want: <= 10 words, starts with a verb. soThat: <= 10 words.
- priority: must (core, ship blocker) / should / could.
- 1-3 acceptance criteria per story, each BROWSER-VERIFIABLE against the running web app:
  given/when/then <= 8 words each; startPath is a real route ("/campaigns");
  steps: 2-6 concrete browser actions, each <= 12 words, e.g. "click 'new campaign'", "fill 'name' with 'q3 launch'", "expect toast 'saved'".
- when the feature is split into pieces, write stories ONLY for this piece; never for the other pieces.
- 2-8 stories. no padding.
`.trim();

const AcceptanceZ = z.object({
  given: z.string(),
  when: z.string(),
  then: z.string(),
  startPath: z.string(),
  steps: z.array(z.string()),
});

const StoriesOut = z.object({
  stories: z.array(
    z.object({
      role: z.string(),
      want: z.string(),
      soThat: z.string(),
      priority: z.enum(["must", "should", "could"]),
      acceptance: z.array(AcceptanceZ),
    }),
  ),
});

export const toAcceptance = (a: z.infer<typeof AcceptanceZ>): Acceptance => ({
  id: id("ac"),
  ...a,
  startPath: a.startPath.startsWith("/") ? a.startPath : `/${a.startPath}`,
  steps: a.steps.slice(0, 8),
});

// Stories for the view's piece (featurePrompt carries the brief + piece scope).
export async function generateStories(feature: FeatureView): Promise<Story[]> {
  const out = await generate({
    schema: StoriesOut,
    system: RULES,
    prompt: `${featurePrompt(feature)}\n\nwrite the user stories for this ${feature.pieces.length > 1 ? "piece" : "feature"}.`,
    maxTokens: 12000,
  });
  return out.stories.map((s) => ({
    id: id("st"),
    role: s.role,
    want: s.want,
    soThat: s.soThat,
    priority: s.priority,
    acceptance: s.acceptance.slice(0, 3).map(toAcceptance),
    status: "todo",
  }));
}

// Edit contract (src/lib/ops.ts): apply one StoryOp in place to a piece view — call inside updateFeature.
// The reducer is pure + shared with the board's optimistic updates (src/lib/stories-apply.ts).
export function applyStoryOp(feature: { stories: Story[] }, op: StoryOp): ChangeNote {
  return applyStoryOpWith(feature, op, id);
}
