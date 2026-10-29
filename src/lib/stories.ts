import "server-only";
import { z } from "zod";
import { factsOf, groundingPrompt } from "./facts";
import { featurePrompt, generate } from "./llm";
import { id } from "./store";
import { featureMode, type Acceptance, type FeatureView, type Story } from "./types";
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
  given/when/then <= 8 words each; startPath is a real route of the app, the one the test opens;
  steps: 2-6 concrete browser actions, each <= 12 words, of the form "click '<button text>'", "fill '<field>' with '<value>'", "expect text '<message>'". copy button / field / heading text verbatim from the facts' visible text when given.
- when the feature is split into pieces, write stories ONLY for this piece; never for the other pieces.
- 2-8 stories. no padding.
`.trim();

// understand: stories document what users can do TODAY (same schema), so a verify run checks the explanation.
const RULES_UNDERSTAND = `
user stories describing an EXISTING feature as it works today: "as a <role>, i can <want>, so that <benefit>". documentation, not a wish list.
- only behaviour the code / running app actually has. never invent capabilities.
- role: 1-3 words. want: <= 10 words, starts with a verb. soThat: <= 10 words.
- priority = importance to the feature: must (core path) / should (secondary) / could (rare or edge).
- 1-3 acceptance criteria per story describing CURRENT observable behaviour, each BROWSER-VERIFIABLE against the running web app:
  given/when/then <= 8 words each; startPath is a real, existing route of the app, the one the test opens;
  steps: 2-6 concrete browser actions, each <= 12 words, of the form "click '<button text>'", "fill '<field>' with '<value>'", "expect text '<message>'". only screens, buttons and text the app has (the facts' visible text when given); copy them verbatim.
- when the feature is split into sub-areas, write stories ONLY for this sub-area.
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

// Stories for the view's piece (featurePrompt carries the brief + piece scope; groundingPrompt the piece's
// facts read from the code, when there are any).
export async function generateStories(feature: FeatureView): Promise<Story[]> {
  const mode = featureMode(feature);
  const multi = feature.pieces.length > 1;
  const g = groundingPrompt(factsOf(feature));
  const head = `${featurePrompt(feature)}${g ? `\n\n${g}` : ""}`;
  const out = await generate({
    schema: StoriesOut,
    system: mode === "understand" ? RULES_UNDERSTAND : RULES,
    prompt:
      mode === "understand"
        ? `${head}\n\nwrite user stories describing how this ${multi ? "sub-area" : "feature"} behaves today.`
        : `${head}\n\nwrite the user stories for this ${multi ? "piece" : "feature"}.`,
    maxTokens: 12000,
    mode,
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
