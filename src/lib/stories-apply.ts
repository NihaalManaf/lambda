import type { ChangeNote, StoryOp } from "@/lib/ops";
import type { AcceptanceDraft } from "@/lib/ops-drafts";
import type { Acceptance, Feature, Priority, Slice, Story } from "@/lib/types";

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

// Lenient slice lookup: id, then title, then 1-based number (the chat may say "slice 2").
export function findSlice(f: Feature, ref: string | undefined): Slice | undefined {
  const slices = f.sizing?.slices ?? [];
  const r = clean(ref);
  if (!r) return undefined;
  return (
    slices.find((s) => s.id === r) ??
    slices.find((s) => s.title.toLowerCase() === r.toLowerCase()) ??
    (/^\d+$/.test(r) ? slices[Number(r) - 1] : undefined)
  );
}

// Keep sizing.slices[].storyIds + verdict consistent with story.sliceId.
export function syncSlicesPure(f: Feature) {
  if (!f.sizing) return;
  const ids = new Set(f.sizing.slices.map((s) => s.id));
  for (const sl of f.sizing.slices) sl.storyIds = [];
  for (const st of f.stories) {
    if (st.sliceId && !ids.has(st.sliceId)) st.sliceId = undefined;
    if (st.sliceId) f.sizing.slices.find((s) => s.id === st.sliceId)!.storyIds.push(st.id);
  }
  f.sizing.verdict = f.sizing.slices.length > 1 ? "split" : "one-piece";
}

const story = (f: Feature, sid: string): Story => {
  const s = f.stories.find((x) => x.id === sid);
  if (!s) throw new Error(`story ${sid} not found`);
  return s;
};

export function applyStoryOpWith(f: Feature, op: StoryOp, mkId: MkId): ChangeNote {
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
      const slices = f.sizing?.slices ?? [];
      const slice = findSlice(f, op.sliceId) ?? (slices.length === 1 ? slices[0] : undefined);
      const s: Story = {
        id: mkId("st"),
        role: clean(op.role) || "user",
        want,
        soThat: clean(op.soThat),
        priority: pri(op.priority) ?? "should",
        sliceId: slice?.id,
        acceptance: (op.acceptance ?? []).slice(0, MAX_CRITERIA).map((a) => toCriterion(a, mkId)),
        status: "todo",
      };
      f.stories.push(s);
      syncSlicesPure(f);
      return note("+", "story", want, s.id);
    }
    case "update_story": {
      const s = story(f, op.storyId);
      if (clean(op.role)) s.role = clean(op.role);
      if (clean(op.want)) s.want = clean(op.want);
      if (op.soThat !== undefined) s.soThat = clean(op.soThat);
      if (pri(op.priority)) s.priority = pri(op.priority)!;
      if (op.sliceId !== undefined) {
        const sl = findSlice(f, op.sliceId);
        if (!sl) throw new Error(`slice ${op.sliceId} not found`);
        s.sliceId = sl.id;
      }
      syncSlicesPure(f);
      return note("~", "story", s.want, s.id);
    }
    case "remove_story": {
      const s = story(f, op.storyId);
      f.stories = f.stories.filter((x) => x.id !== s.id);
      syncSlicesPure(f);
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
      return note("~", "criterion", a.then || s.want, s.id);
    }
    case "remove_criterion": {
      const s = story(f, op.storyId);
      const a = s.acceptance.find((x) => x.id === op.criterionId);
      if (!a) throw new Error(`criterion ${op.criterionId} not found`);
      s.acceptance = s.acceptance.filter((x) => x.id !== a.id);
      return note("−", "criterion", a.then || s.want, s.id);
    }
    case "add_slice": {
      const title = clean(op.title);
      if (!title) throw new Error("slice needs a title");
      const first = !f.sizing || !f.sizing.slices.length;
      f.sizing ??= { verdict: "one-piece", reason: "", slices: [] };
      const sl: Slice = { id: mkId("sl"), title, why: clean(op.why), storyIds: [] };
      const after = findSlice(f, op.after);
      const at = after ? f.sizing.slices.indexOf(after) + 1 : f.sizing.slices.length;
      f.sizing.slices.splice(at, 0, sl);
      // the first slice adopts every story so nothing goes unsliced
      if (first) for (const s of f.stories) s.sliceId = sl.id;
      syncSlicesPure(f);
      return note("+", "slice", title, sl.id);
    }
    case "rename_slice": {
      const sl = findSlice(f, op.sliceId);
      if (!sl) throw new Error(`slice ${op.sliceId} not found`);
      const title = clean(op.title);
      if (!title) throw new Error("slice needs a title");
      sl.title = title;
      return note("~", "slice", title, sl.id);
    }
    default: {
      const never: never = op;
      throw new Error(`unknown story op ${(never as { op: string }).op}`);
    }
  }
}
