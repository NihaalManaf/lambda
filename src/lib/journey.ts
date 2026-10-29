import "server-only";
import { z } from "zod";
import { generate } from "./llm";
import { findPiece, pieceView } from "./pieces";
import { getFeature, updateFeature } from "./store";
import { featureMode, type FeatureView, type Piece } from "./types";

// A piece's stories, grouped by the user's journey (story mapping): the model names the 3–6 steps a user goes
// through, in order, and puts every story in one. Priority stays a property of each story, read down a step.
// Re-mapping keeps steps the developer already has and only places stories that have none.

const Out = z.object({
  steps: z.array(z.string()).describe("3-6 journey steps in the order a user goes through them, each <= 4 words, lowercase"),
  stories: z.array(z.object({ id: z.string(), step: z.string().describe("exactly one of steps") })),
});

const words = (s: string, n: number) => s.replace(/\s+/g, " ").trim().split(" ").slice(0, n).join(" ").toLowerCase();

function prompt(f: FeatureView, p: Piece): string {
  const flows = f.flowcharts.flatMap((set) => set.charts.map((c) => `- ${c.title}: ${c.nodes.map((n) => n.label).join(" → ")}`));
  const keep = p.journey?.length ? `\nKeep these existing steps, in this order (you may add up to two missing ones): ${p.journey.join(" | ")}` : "";
  return [
    `${featureMode(f) === "understand" ? "existing feature" : "feature"}: ${f.title}`,
    `area: ${p.title}${p.why ? ` — ${p.why}` : ""}`,
    `\nflows:\n${flows.join("\n") || "(none)"}`,
    `\nstories:\n${f.stories.map((s) => `${s.id} [${s.priority}] ${s.role}: ${s.want}`).join("\n")}`,
    keep,
    `\nName the steps of the journey through this area, in order — what the user (or, for background work, the system) goes through: e.g. "pick databases", "pay", "access unlocked". Steps are moments in the journey, never priorities or story types. Then place every story id in exactly one step.`,
  ].join("\n");
}

export async function mapJourney(fid: string, pieceId: string): Promise<FeatureView> {
  const stored = getFeature(fid);
  const piece = stored && findPiece(stored, pieceId);
  if (!stored || !piece) throw new Error("piece not found");
  const view = pieceView(stored, piece.id);
  if (!view.stories.length) return view;
  const out = await generate({ schema: Out, prompt: prompt(view, piece), effort: "low", maxTokens: 2000, mode: featureMode(view) });
  const steps = [...new Set([...(piece.journey ?? []), ...out.steps.map((s) => words(s, 4))].filter(Boolean))].slice(0, 7);
  const placed = new Map(out.stories.map((x) => [x.id, words(x.step, 4)]));
  const next = await updateFeature(fid, (f) => {
    const p = findPiece(f, piece.id);
    if (!p) return;
    p.journey = steps;
    for (const s of p.stories) {
      if (s.step && steps.includes(s.step)) continue; // the developer's (or an earlier) placement stays
      const step = placed.get(s.id);
      if (step && steps.includes(step)) s.step = step;
    }
  });
  return pieceView(next, piece.id);
}
