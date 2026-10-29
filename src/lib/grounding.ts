import "server-only";
import { counts, valueOf, type CheckPlan } from "./check";
import { CheckBlockSchema, FactsBlockSchema, salvageFacts, type CheckItem, type FactsBlock } from "./facts";
import { applyFlowOp, edgeCasesOn } from "./flows";
import { extractBlock, lastBlockJson } from "./intake-parse";
import { addIssues } from "./issues";
import type { FlowOp, StoryOp } from "./ops";
import { scanRoutes, type RouteEntry } from "./routes";
import { now } from "./store";
import { applyStoryOp } from "./stories";
import { featureMode, type FeatureMode, type FeatureView, type PieceCheck, type PieceFacts } from "./types";

// Grounding for the shaping jobs (src/lib/jobs.ts "facts" / "check"): a Claude Code session per piece reads
// the checkout and writes a lambda-facts block (→ piece.facts, read by the stories / flows / needs prompts);
// after stories + flows, a verifier session checks them against the code (lambda-check → src/lib/check.ts).
// Both run as their own session (never the intake one) through intake's runner, on the feature's checkout.

export const FACTS_LIMITS = { maxTurns: 30, timeoutMs: 5 * 60_000 };
export const CHECK_LIMITS = { maxTurns: 30, timeoutMs: 5 * 60_000 };
const FIX_LIMITS = { maxTurns: 4, timeoutMs: 90_000 }; // the one re-ask: re-emit the block
const MAX_ROUTES_IN_PROMPT = 120;

const intake = () => import("./intake"); // lazy: intake → jobs → grounding → intake

const NO_BLOCKS = "never emit lambda-ask, lambda-brief or lambda-issue blocks. never write code or change files.";

export const factsSystem = (mode: FeatureMode) => `
you are lambda's code reader. you map where one part of a feature lives in this checkout so lambda's writers can ground user stories, flowcharts and browser tests in real code. you never change code, never build, never ask questions.
${mode === "understand" ? "the feature EXISTS: map it as it works today." : "the feature is NOT built yet: map where the change will live and what already exists that it builds on. never describe the new behaviour as if it existed."}
how to work:
- read the code (Read, Grep, Glob). start from the app routes listed in the prompt; open the pages, handlers, tables and guards this part touches.
- only facts you read. every item cites where you read it as path:line, relative to the checkout root.
- routes: paths from the app route list (or, for a non-next frontend, routes you found registered in code); [param] for dynamic segments. <= 12.
- labels: text a person sees or clicks on that screen — button text, field labels, headings, tabs, empty states, toasts — copied verbatim (keep case). <= 16 per route.
- endpoints: api routes / handlers this part calls. tables: db tables it reads or writes. gates: what decides who / when (auth, roles, flags, plan limits, redirects). components: the main ui pieces.
- notes: <= 6 short facts a writer would get wrong without the code (each <= 25 words, cite file:line).
when done, reply with exactly one fenced block and nothing after it:
\`\`\`lambda-facts
{"routes": [{"path": "/things/[id]", "screen": "<= 5 words", "labels": ["Save changes"], "file": "src/app/things/[id]/page.tsx:12"}],
 "endpoints": [{"method": "POST", "path": "/api/things", "file": "src/app/api/things/route.ts:8"}],
 "tables": ["things"],
 "gates": [{"what": "owners only", "file": "src/lib/auth.ts:40"}],
 "components": [{"name": "ThingForm", "file": "src/components/ThingForm.tsx:5"}],
 "notes": ["drafts are soft-deleted (src/lib/things.ts:88)"]}
\`\`\`
the JSON must be valid; empty lists are fine. ${NO_BLOCKS}
`.trim();

export const checkSystem = (mode: FeatureMode) => `
you are lambda's checker. lambda wrote user stories and flowcharts for one part of a feature from a brief and some notes. you verify their claims against this checkout and report. you never change code, never ask questions.
${
  mode === "understand"
    ? "the feature EXISTS: every story, criterion, node and edge case claims how it works today. judge each against the code."
    : "the feature is NOT built yet: new behaviour is expected to be missing — never call it wrong for that. judge only what they assume already exists: start routes, screens / buttons / fields a step uses before the new part, tables, endpoints and services they name."
}
how to work:
- read the code (Read, Grep, Glob). cite path:line as evidence for every verdict but "unsure".
- verdict: ok (the code backs it), wrong (the code contradicts it), unsure (couldn't tell). skip trivia; <= 40 items; why <= 20 words.
- when wrong and ONE field's new value would make it right, give fix {field, value}: criterion → given | when | then | startPath | steps (steps = array of strings); story → role | want | soThat; node → label (<= 5 words); edgeCase → text (<= 12 words). anything else: no fix, say why.
- a startPath is one of the app's real routes (fill a [param] with a plausible value). steps copy visible text verbatim from the code.
- target ids come from the listing: criterion targets carry storyId; node / edgeCase targets carry setId and chartId.
reply with exactly one fenced block and nothing after it:
\`\`\`lambda-check
[{"target": {"kind": "criterion", "id": "ac_1", "storyId": "st_1"}, "verdict": "wrong", "fix": {"field": "startPath", "value": "/things"}, "evidence": "src/app/things/page.tsx:1", "why": "the list lives at /things"},
 {"target": {"kind": "node", "id": "n2", "setId": "fs_1", "chartId": "fc_1"}, "verdict": "ok", "evidence": "src/lib/things.ts:20", "why": "validates before insert"}]
\`\`\`
the JSON must be valid. ${NO_BLOCKS}
`.trim();

type Wt = { dir: string; sha: string; branch: string };
const clip = (s: string | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function pieceLines(v: FeatureView): string[] {
  const u = featureMode(v) === "understand";
  const pieces = [...v.pieces].sort((a, b) => a.order - b.order);
  const me = pieces.find((p) => p.id === v.pieceId);
  const out = [u ? `feature to understand: ${v.title} (it already exists in this codebase)` : `feature being shaped: ${v.title} (not built yet)`];
  if (v.brief.trim()) out.push(`brief: ${clip(v.brief, 600)}`);
  if (me && pieces.length > 1) {
    out.push(`this ${u ? "sub-area" : "piece"} (${me.order} of ${pieces.length}): "${me.title}"${me.why ? ` — ${me.why}` : ""}`);
    const others = pieces.filter((p) => p !== me).map((p) => `${p.order}. ${p.title}`);
    out.push(`other ${u ? "sub-areas" : "pieces"} (stay out of them): ${others.join("; ")}`);
  }
  if (me?.scope?.length) out.push(`scope:\n${me.scope.map((x) => `- ${x}`).join("\n")}`);
  const surfaces = v.briefDoc?.surfaces ?? [];
  if (surfaces.length) out.push(`surfaces the intake named (a guess — verify): ${surfaces.slice(0, 15).join(", ")}`);
  return out;
}

const routeList = (routes: RouteEntry[]) =>
  routes.length
    ? `app routes found in this checkout (next app/ + pages/ dirs; [param] = dynamic):\n${routes
        .slice(0, MAX_ROUTES_IN_PROMPT)
        .map((r) => `${r.path}  (${r.file})`)
        .join("\n")}${routes.length > MAX_ROUTES_IN_PROMPT ? `\n… ${routes.length - MAX_ROUTES_IN_PROMPT} more` : ""}`
    : "no next app/ or pages/ routes were found: find how this frontend registers its routes.";

export function factsPrompt(v: FeatureView, wt: Wt, routes: RouteEntry[]): string {
  const u = featureMode(v) === "understand";
  return [
    `you're in a read-only checkout of ${wt.branch} @ ${wt.sha.slice(0, 7)}.`,
    ...pieceLines(v),
    routeList(routes),
    u
      ? "task: map how this part works TODAY — the screens a person uses and what they see and click there, the endpoints and tables behind them, and what gates them. then write the lambda-facts block."
      : "task: map where this change will live and what already exists that it builds on — the screens it extends or sits next to (with their current visible text), the endpoints / tables / components it will reuse or change, and the gates that will apply. then write the lambda-facts block.",
  ].join("\n\n");
}

// stories + flows with qualified ids (node / edge case ids repeat across charts)
function listing(v: FeatureView): string {
  const out: string[] = [`stories (${v.stories.length}):`];
  for (const s of v.stories) {
    out.push(`- story ${s.id}: as a ${clip(s.role, 30)}, i can ${clip(s.want, 100)}, so that ${clip(s.soThat, 80)}`);
    for (const a of s.acceptance)
      out.push(
        `  - criterion ${a.id} (storyId ${s.id}): given ${clip(a.given, 60)} · when ${clip(a.when, 60)} · then ${clip(a.then, 80)} · startPath ${a.startPath}${a.steps.length ? ` · steps: ${a.steps.map((x) => clip(x, 70)).join(" / ")}` : ""}`,
      );
  }
  out.push(`\nflowcharts (${v.flowcharts.length} sets):`);
  for (const set of v.flowcharts)
    for (const c of set.charts) {
      out.push(`- chart "${clip(c.title, 40)}" (setId ${set.id}, chartId ${c.id}, lens ${set.lens})`);
      for (const n of c.nodes) out.push(`  - node ${n.id} (${n.kind}): ${clip(n.label, 40)}${n.description ? ` — ${clip(n.description, 120)}` : ""}`);
      if (edgeCasesOn()) for (const e of c.edgeCases) out.push(`  - edgeCase ${e.id} @${e.nodeId}: ${clip(e.text, 80)}`);
    }
  return out.join("\n");
}

export function checkPrompt(v: FeatureView, wt: Wt, routes: RouteEntry[]): string {
  return [
    `you're in a read-only checkout of ${wt.branch} @ ${wt.sha.slice(0, 7)}.`,
    ...pieceLines(v),
    routeList(routes),
    listing(v),
    "the same stories / flows are in lambda's workspace (piece json), next to the facts read for this part. check them against the code, then write the lambda-check block.",
  ].join("\n\n");
}

type SessionOpts = { signal?: AbortSignal; onStatus?: (line: string) => void };
const key = (v: FeatureView, kind: string) => `${v.id}:${kind}:${v.pieceId}`;
const emptyFacts = (routes: RouteEntry[], sha: string, incomplete: string): PieceFacts => ({
  routes: [], endpoints: [], tables: [], gates: [], components: [], notes: [],
  appRoutes: routes.map((r) => r.path), sha, at: now(), incomplete: incomplete.slice(0, 160),
});

// facts for the view's piece. error: the session failed (the routes scan is still returned, marked incomplete)
export async function readFacts(v: FeatureView, o: SessionOpts = {}): Promise<{ facts: PieceFacts; error?: string; skipped?: string }> {
  const { runCodeSession } = await intake();
  let routes: RouteEntry[] = [];
  let sha = "";
  try {
    const r = await runCodeSession<FactsBlock>({
      fid: v.id,
      key: key(v, "facts"),
      system: factsSystem(featureMode(v)),
      prompt: (wt) => {
        sha = wt.sha;
        routes = scanRoutes(wt.dir);
        return factsPrompt(v, wt, routes);
      },
      limits: FACTS_LIMITS,
      fixLimits: FIX_LIMITS,
      parse: (all, final) => {
        const b = extractBlock(all, "facts", FactsBlockSchema);
        if (b && "data" in b) return b;
        if (final) {
          const raw = lastBlockJson(all, "facts");
          const salvaged = raw && "json" in raw ? salvageFacts(raw.json) : null;
          if (salvaged) return { data: salvaged };
        }
        return { error: b?.error ?? "no lambda-facts block" };
      },
      fixPrompt: (e) => `your lambda-facts block didn't validate (${e}). re-emit exactly one valid lambda-facts block, nothing else.`,
      ...o,
    });
    if ("skipped" in r) return { facts: emptyFacts([], "", r.skipped), skipped: r.skipped };
    return { facts: { ...r.data, appRoutes: routes.map((x) => x.path), sha: r.sha, at: now() } };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { facts: emptyFacts(routes, sha, error), error };
  }
}

// the verifier's verdicts for the view's piece, and the routes scanned in the checkout it read
export async function runVerifier(v: FeatureView, o: SessionOpts = {}): Promise<{ items: CheckItem[]; routes: string[]; sha?: string; skipped?: string }> {
  const { runCodeSession } = await intake();
  let routes: RouteEntry[] = [];
  const r = await runCodeSession<CheckItem[]>({
    fid: v.id,
    key: key(v, "check"),
    system: checkSystem(featureMode(v)),
    prompt: (wt) => {
      routes = scanRoutes(wt.dir);
      return checkPrompt(v, wt, routes);
    },
    limits: CHECK_LIMITS,
    fixLimits: FIX_LIMITS,
    parse: (all) => extractBlock(all, "check", CheckBlockSchema) ?? { error: "no lambda-check block" },
    fixPrompt: (e) => `your lambda-check block didn't validate (${e}). re-emit exactly one valid lambda-check block, nothing else.`,
    ...o,
  });
  if ("skipped" in r) return { items: [], routes: [], skipped: r.skipped };
  return { items: r.data, routes: routes.map((x) => x.path), sha: r.sha };
}

const STORY_OPS = new Set(["add_story", "update_story", "remove_story", "add_criterion", "update_criterion", "remove_criterion"]);

// Commit a plan into a piece view (inside updateFeature, via withPiece): story / flow fixes through the edit
// contract, skipping any target a person changed since it was planned; understand issues; piece.check.
export function applyCheckPlan(v: FeatureView, plan: CheckPlan, extra: { sha?: string; note?: string } = {}): PieceCheck {
  let fixed = 0;
  let flagged = plan.issues.length + plan.flags.length;
  for (const o of plan.ops) {
    if (valueOf(v, o.ref, o.field) !== o.before) continue;
    try {
      if (STORY_OPS.has(o.op.op)) applyStoryOp(v, o.op as StoryOp);
      else void applyFlowOp(v, o.op as FlowOp); // graph ops only: sync
      fixed += counts(o.tally).fixed;
      flagged += counts(o.tally).flagged;
    } catch {
      // gone or refused: skipped
    }
  }
  if (featureMode(v) === "understand") {
    // a re-check replaces this piece's open check issues on what it judged again (reworded or now ok)
    for (const i of v.issues ?? [])
      if (i.source === "check" && i.status === "open" && i.pieceId === v.pieceId && i.ref && plan.judged.includes(i.ref.id)) i.status = "dropped";
    if (plan.issues.length) addIssues(v, plan.issues, "check");
  }
  const check: PieceCheck = {
    ok: plan.counts.ok,
    fixed,
    flagged,
    ...(plan.counts.unsure ? { unsure: plan.counts.unsure } : {}),
    at: now(),
    ...(extra.sha ? { sha: extra.sha } : {}),
    ...(extra.note ? { note: extra.note } : {}),
    ...(plan.flags.length ? { flags: plan.flags.slice(0, 40) } : {}),
  };
  const p = v.pieces.find((x) => x.id === v.pieceId);
  if (p) p.check = check;
  return check;
}

export const checkNote = (c: PieceCheck) =>
  [`${c.ok} ok`, c.fixed ? `${c.fixed} fixed` : "", c.flagged ? `${c.flagged} flagged` : "", c.unsure ? `${c.unsure} unsure` : "", c.note ?? ""].filter(Boolean).join(" · ");

export const factsNote = (f: PieceFacts) =>
  f.incomplete
    ? `${f.appRoutes.length} app routes · facts not read (${f.incomplete})`
    : `${f.routes.length} screens · ${f.endpoints.length} endpoints · ${f.tables.length} tables${f.sha ? ` · ${f.sha.slice(0, 7)}` : ""}`;
