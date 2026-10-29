import type { ChangeNote, StoryOp } from "@/lib/ops";
import type { AcceptanceDraft } from "@/lib/ops-drafts";
import type { Acceptance, Priority, Story } from "@/lib/types";

// Pure story-op reducer shared by the server (applyStoryOp, real ids) and the board (optimistic, temp ids).
// Mutates `f` in place and returns a ChangeNote. Throws on a missing target.

type MkId = (prefix: string) => string;

const PRI: Priority[] = ["must", "should", "could"];
const MAX_STEPS = 8;
const MAX_CRITERIA = 6;

const clean = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");
const short = (s: string, n = 6) => clean(s).split(" ").slice(0, n).join(" ") || "untitled";
export const normPath = (p: unknown) => {
  const t = clean(p) || "/";
  return t.startsWith("/") ? t : `/${t}`;
};
const steps = (s: unknown) => (Array.isArray(s) ? s.map(clean).filter(Boolean).slice(0, MAX_STEPS) : []);
const pri = (p: unknown): Priority | undefined => (PRI.includes(p as Priority) ? (p as Priority) : undefined);

export function toCriterion(d: Partial<AcceptanceDraft>, mkId: MkId): Acceptance {
  return {
    id: mkId("ac"),
    given: clean(d.given),
    when: clean(d.when),
    then: clean(d.then),
    startPath: normPath(d.startPath),
    steps: steps(d.steps),
  };
}

// the stories of one piece (a FeatureView or the piece itself)
type Target = { stories: Story[] };

const story = (f: Target, sid: string): Story => {
  const s = f.stories.find((x) => x.id === sid);
  if (!s) throw new Error(`story ${sid} not found`);
  return s;
};

export function applyStoryOpWith(f: Target, op: StoryOp, mkId: MkId): ChangeNote {
  const note = (sign: ChangeNote["sign"], what: ChangeNote["what"], label: string, ref?: string): ChangeNote => ({
    sign,
    what,
    label: short(label),
    tab: "stories",
    ref,
  });

  switch (op.op) {
    case "add_story": {
      const want = clean(op.want);
      if (!want) throw new Error("story needs an 'i want'");
      const s: Story = {
        id: mkId("st"),
        role: clean(op.role) || "user",
        want,
        soThat: clean(op.soThat),
        priority: pri(op.priority) ?? "should",
        acceptance: (op.acceptance ?? []).slice(0, MAX_CRITERIA).map((a) => toCriterion(a, mkId)),
        status: "todo",
      };
      f.stories.push(s);
      return note("+", "story", want, s.id);
    }
    case "update_story": {
      const s = story(f, op.storyId);
      if (clean(op.role)) s.role = clean(op.role);
      if (clean(op.want)) s.want = clean(op.want);
      if (op.soThat !== undefined) s.soThat = clean(op.soThat);
      if (pri(op.priority)) s.priority = pri(op.priority)!;
      return note("~", "story", s.want, s.id);
    }
    case "remove_story": {
      const s = story(f, op.storyId);
      f.stories = f.stories.filter((x) => x.id !== s.id);
      return note("−", "story", s.want);
    }
    case "add_criterion": {
      const s = story(f, op.storyId);
      if (s.acceptance.length >= MAX_CRITERIA) throw new Error(`max ${MAX_CRITERIA} criteria per story`);
      const a = toCriterion(op.criterion, mkId);
      s.acceptance.push(a);
      return note("+", "criterion", a.then || a.when || s.want, s.id);
    }
    case "update_criterion": {
      const s = story(f, op.storyId);
      const a = s.acceptance.find((x) => x.id === op.criterionId);
      if (!a) throw new Error(`criterion ${op.criterionId} not found`);
      const c = op.criterion;
      if (c.given !== undefined) a.given = clean(c.given);
      if (c.when !== undefined) a.when = clean(c.when);
      if (c.then !== undefined) a.then = clean(c.then);
      if (c.startPath !== undefined) a.startPath = normPath(c.startPath);
      if (c.steps !== undefined) a.steps = steps(c.steps);
      // the check stage marks; an edit to what it judged (route / steps) supersedes the mark
      const mark = c.unverified === undefined ? undefined : clean(c.unverified).slice(0, 200);
      if (mark) a.unverified = mark;
      else if (mark === "" || c.startPath !== undefined || c.steps !== undefined) delete a.unverified;
      return note("~", "criterion", a.then || s.want, s.id);
    }
    case "remove_criterion": {
      const s = story(f, op.storyId);
      const a = s.acceptance.find((x) => x.id === op.criterionId);
      if (!a) throw new Error(`criterion ${op.criterionId} not found`);
      s.acceptance = s.acceptance.filter((x) => x.id !== a.id);
      return note("−", "criterion", a.then || s.want, s.id);
    }
    default: {
      const never: never = op;
      throw new Error(`unknown story op ${(never as { op: string }).op}`);
    }
  }
}
