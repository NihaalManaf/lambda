import "server-only";
import { z } from "zod";
import { discoverContext, mergeDiscovered } from "./autocontext";
import { BUDGET_MS as SKETCH_BUDGET_MS, autoSketch, mergeAutoMockups } from "./autosketch";
import { removeShot } from "./capture";
import { generateFlows } from "./flows";
import { featurePrompt, generate } from "./llm";
import { ensurePiece, findPiece, pieceView, withPiece } from "./pieces";
import { proposeFromPrompt as proposeQueues } from "./queues/propose";
import { proposeFromPrompt as proposeSchema } from "./schema/propose";
import { getFeature, listFeatures, now, updateFeature } from "./store";
import { generateStories } from "./stories";
import {
  INFRA_LENS,
  autoLenses,
  isFeatureJobKind,
  type Feature,
  type FeatureJobKind,
  type FeatureNeeds,
  type FeatureView,
  type Job,
  type JobKind,
  type PieceJobKind,
} from "./types";

// Background generation. In-process, never awaited by the request that starts it; status lives in
// feature.jobs (feature-level: context) and piece.jobs (per piece: stories, flows, needs → schema/queues),
// so any tab (or a reload) sees progress. Order: context → every piece in parallel (stories → sketch ∥ flows ∥
// needs → schema/queues). Piece work runs on a pieceView: featurePrompt carries the brief + piece scope.

// kinds a client may start (intake / pieces belong to the intake flow)
export const JOB_KINDS: JobKind[] = ["context", "stories", "flows", "schema", "queues", "needs", "sketch"];
const PIECE_FULL: PieceJobKind[] = ["stories", "flows", "needs", "sketch"];
const CONTEXT_BUDGET_MS = 25_000;

// survives HMR module reloads; one per process
const G = globalThis as { __lambdaJobs?: { live: Set<string>; detail: Map<string, { schema?: string; queues?: string }> } };
const state = (G.__lambdaJobs ??= { live: new Set(), detail: new Map() });
const key = (fid: string, k: JobKind, pid?: string) => (pid && !isFeatureJobKind(k) ? `${fid}:${pid}:${k}` : `${fid}:${k}`);

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 140);

export const isActive = (j: Job) => j.status === "queued" || j.status === "running";

// The list a job kind lives in: feature.jobs (feature kinds) or the piece's jobs.
function jobList(f: Feature, k: JobKind, pid?: string): Job[] {
  if (isFeatureJobKind(k)) return (f.jobs ??= []);
  const p = pid ? f.pieces.find((x) => x.id === pid) : undefined;
  if (!p) throw new Error(`piece ${pid} not found`);
  return (p.jobs ??= []);
}

// Mark kinds queued on f (in place) unless already live here, or active under another live process
// (the installed app and `next dev` share one store). Returns accepted kinds.
function markQueued<K extends JobKind>(f: Feature, kinds: K[], pid?: string): K[] {
  const accepted: K[] = [];
  for (const k of [...new Set(kinds)]) {
    const list = jobList(f, k, pid);
    const elsewhere = list.some((j) => j.kind === k && isActive(j) && !!j.pid && j.pid !== process.pid && alive(j.pid));
    if (state.live.has(key(f.id, k, pid)) || elsewhere) continue;
    state.live.add(key(f.id, k, pid));
    const j: Job = { kind: k, status: "queued", pid: process.pid };
    const i = list.findIndex((x) => x.kind === k);
    if (i >= 0) list[i] = j;
    else list.push(j);
    accepted.push(k);
  }
  return accepted;
}

type Plan = { feature: FeatureJobKind[]; pieces: { pid: string; kinds: PieceJobKind[] }[] };
const isView = (f: Feature) => typeof (f as FeatureView).pieceId === "string";

// Sync, for callers already inside updateFeature (e.g. applyContextOp "rediscover", which may hand us a
// pieceView: only feature-level kinds are allowed there — withPiece writes them back).
// kinds omitted = the full pipeline: context + every piece (or only pieceId) → stories, flows, needs check.
// Piece kinds without a pieceId go to the first piece (created if the feature has none).
export function queueJobsInPlace(f: Feature, kinds?: JobKind[], pieceId?: string): JobKind[] {
  const featureKinds = (kinds ? kinds.filter(isFeatureJobKind) : ["context"]).filter((k): k is FeatureJobKind => k === "context");
  const pieceKinds = (kinds ? kinds.filter((k) => !isFeatureJobKind(k)) : PIECE_FULL) as PieceJobKind[];
  const plan: Plan = { feature: [], pieces: [] };
  if (pieceKinds.length) {
    if (isView(f)) throw new Error("piece jobs must be queued on the stored feature");
    const targets = !kinds && !pieceId && f.pieces.length ? f.pieces : [pieceId ? findPiece(f, pieceId) : ensurePiece(f)];
    for (const p of targets) {
      if (!p) throw new Error(`piece ${pieceId} not found`);
      if (pieceKinds.includes("schema") || pieceKinds.includes("queues"))
        p.needs = {
          schema: !!p.needs?.schema || pieceKinds.includes("schema"),
          queues: !!p.needs?.queues || pieceKinds.includes("queues"),
          why: p.needs?.why ?? "added by hand",
        };
      const accepted = markQueued(f, pieceKinds, p.id);
      if (accepted.length) plan.pieces.push({ pid: p.id, kinds: accepted });
    }
  }
  plan.feature = markQueued(f, featureKinds);
  const all: JobKind[] = [...plan.feature, ...plan.pieces.flatMap((p) => p.kinds)];
  if (all.length) setTimeout(() => void run(f.id, plan), 0); // after the caller's lock
  return all;
}

export async function startJobs(fid: string, kinds?: JobKind[], pieceId?: string): Promise<Feature> {
  return updateFeature(fid, (f) => void queueJobsInPlace(f, kinds, pieceId));
}

// Intake settled (brief + pieces written by the caller): phase → "shaping", then context + every piece's
// pipeline. The phase flips to "ready" once every job has settled.
export async function startShaping(fid: string): Promise<Feature> {
  return updateFeature(fid, (f) => {
    f.phase = "shaping";
    queueJobsInPlace(f);
  });
}

// ---------- runner ----------

function setJob(fid: string, k: JobKind, pid: string | undefined, patch: Partial<Job>) {
  return updateFeature(fid, (f) => {
    const list = jobList(f, k, pid);
    const j = list.find((x) => x.kind === k);
    if (j) Object.assign(j, patch);
    else list.push({ kind: k, status: "queued", ...patch });
  });
}

type Work = (view: FeatureView) => Promise<(view: FeatureView) => void>;

// One job: running → work on a pieceView (outside the lock) → commit into the same piece + done (inside).
// Feature-level jobs (context) get the first piece's view and may only touch feature-level fields.
async function job(fid: string, k: JobKind, pid: string | undefined, work: Work) {
  try {
    await setJob(fid, k, pid, { status: "running", startedAt: now(), finishedAt: undefined, error: undefined, note: undefined, pid: process.pid });
    const f0 = getFeature(fid);
    if (!f0) throw new Error("feature gone");
    const commit = await work(pieceView(f0, pid));
    await updateFeature(fid, (f) => {
      if (isFeatureJobKind(k) && !f.pieces.length) {
        const v = pieceView(f);
        commit(v);
        Object.assign(f, { context: v.context, discovery: v.discovery }); // feature-level only
      } else withPiece(f, isFeatureJobKind(k) ? undefined : pid, commit);
      const j = jobList(f, k, pid).find((x) => x.kind === k);
      if (j) Object.assign(j, { status: "done", finishedAt: now() });
    });
  } catch (e) {
    await setJob(fid, k, pid, { status: "error", error: short(e), finishedAt: now() }).catch(() => undefined);
  } finally {
    state.live.delete(key(fid, k, pid));
  }
}

const detailKey = (fid: string, pid: string) => `${fid}:${pid}`;

const WORK: Record<"context" | "stories" | "flows" | "schema" | "queues" | "sketch", (fid: string, pid: string) => Work> = {
  context: () => async (f0) => {
    const { refs, status } = await discoverContext(f0, { timeoutMs: CONTEXT_BUDGET_MS });
    return (f) => mergeDiscovered(f, refs, status);
  },
  stories: () => async (f0) => {
    const before = new Set(f0.stories.map((s) => s.id));
    const stories = await generateStories(f0);
    return (f) => {
      // story ops are refused while this job runs (applyOps); anything that still slipped in is kept
      const addedMeanwhile = f.stories.filter((s) => !before.has(s.id));
      f.stories = [...stories, ...addedMeanwhile];
    };
  },
  flows: () => async (f0) => {
    const startedAt = f0.jobs?.find((j) => j.kind === "flows")?.startedAt ?? new Date().toISOString();
    const res = await Promise.allSettled(autoLenses(f0).map((lens) => generateFlows(f0, lens)));
    const sets = res.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (!sets.length) throw (res[0] as PromiseRejectedResult).reason;
    const replaced = new Set(f0.flowcharts.filter((s) => sets.some((n) => n.lens === s.lens)).map((s) => s.id));
    return (f) => {
      // also replace same-lens sets drawn while we ran (draw_lens is refused meanwhile; belt and braces)
      const drawnMeanwhile = (s: (typeof f.flowcharts)[number]) => sets.some((n) => n.lens === s.lens) && s.createdAt >= startedAt;
      f.flowcharts = [...f.flowcharts.filter((s) => !replaced.has(s.id) && !drawnMeanwhile(s)), ...sets];
    };
  },
  schema: (fid, pid) => async (f0) => {
    const p = await proposeSchema(f0, state.detail.get(detailKey(fid, pid))?.schema || f0.needs?.why || f0.brief || f0.title);
    return (f) => void (f.schema = [...(f.schema ?? []), p]);
  },
  queues: (fid, pid) => async (f0) => {
    const p = await proposeQueues(f0, state.detail.get(detailKey(fid, pid))?.queues || f0.needs?.why || f0.brief || f0.title);
    return (f) => void (f.queues = [...(f.queues ?? []), p]);
  },
  // screenshots of the running app, marked up. Capped at ~3 min; one browser at a time.
  sketch: (_fid, pid) => async (f0) => {
    const piece = f0.pieces.find((p) => p.id === pid);
    if (!piece) throw new Error(`piece ${pid} not found`);
    // its routes come from the stories: a failed / unfinished stories job means guessing (and the wrong page)
    const stories = f0.jobs?.find((j) => j.kind === "stories");
    if (stories && isActive(stories)) throw new Error("stories still running — retry when they finish");
    if (stories?.status === "error") throw new Error("stories failed — retry stories first");
    const { mockups, skipped } = await autoSketch(f0, piece, { signal: AbortSignal.timeout(SKETCH_BUDGET_MS + 15_000) });
    return (f) => {
      const { mockups: next, removed } = mergeAutoMockups(f.mockups, mockups);
      f.mockups = next;
      for (const m of removed) removeShot(m.shot);
      const j = f.jobs?.find((x) => x.kind === "sketch");
      if (j && skipped.length) j.note = skipped.join("; ").slice(0, 300);
    };
  },
};

const NeedsOut = z.object({
  schema: z.boolean().describe("this piece adds/changes db tables, columns, indexes or enums"),
  queues: z.boolean().describe("this piece adds/changes async jobs, queues, workers, crons or webhooks"),
  why: z.string().describe("<= 12 words"),
  schemaChange: z.string().describe("if schema: the db change in <= 25 words, else empty"),
  queueChange: z.string().describe("if queues: the async change in <= 25 words, else empty"),
});

const pieceOf = (fid: string, pid: string) => {
  const f = getFeature(fid);
  return f && f.pieces.some((p) => p.id === pid) ? pieceView(f, pid) : undefined;
};

// cheap relevance check → piece.needs, then the matching proposal jobs. Tracked as the piece's "needs" job.
async function needsCheck(fid: string, pid: string) {
  try {
    await setJob(fid, "needs", pid, { status: "running", startedAt: now(), finishedAt: undefined, error: undefined, pid: process.pid });
    const v0 = pieceOf(fid, pid);
    if (!v0) return;
    let needs: FeatureNeeds | undefined = v0.needs;
    if (!needs) {
      const out = await generate({
        schema: NeedsOut,
        effort: "low",
        maxTokens: 800,
        prompt: `${featurePrompt(v0)}\n\ndoes building this ${v0.pieces.length > 1 ? "piece" : "feature"} change the database schema? does it add or change async work (queues, background jobs, crons, webhooks)? say false unless clearly needed.`,
      });
      needs = { schema: out.schema, queues: out.queues, why: out.why.split(/\s+/).slice(0, 12).join(" ") };
      state.detail.set(detailKey(fid, pid), { schema: out.schemaChange || undefined, queues: out.queueChange || undefined });
    }
    const kinds: PieceJobKind[] = [
      ...(needs.schema && !v0.schema?.length ? (["schema"] as const) : []),
      ...(needs.queues && !v0.queues?.length ? (["queues"] as const) : []),
    ];
    let accepted: PieceJobKind[] = [];
    const final = needs;
    await updateFeature(fid, (f) => {
      const p = f.pieces.find((x) => x.id === pid);
      if (!p) return;
      p.needs = p.needs ?? final;
      accepted = markQueued(f, kinds, pid);
      const j = p.jobs?.find((x) => x.kind === "needs");
      if (j) Object.assign(j, { status: "done", finishedAt: now() });
    });
    await Promise.all([...accepted.map((k) => job(fid, k, pid, WORK[k as "schema" | "queues"](fid, pid))), drawInfra(fid, pid, needs)]);
  } catch (e) {
    // needs is optional: the ghost chips still let a person add schema/queues
    await setJob(fid, "needs", pid, { status: "error", error: short(e), finishedAt: now() }).catch(() => undefined);
  } finally {
    state.detail.delete(detailKey(fid, pid));
    state.live.delete(key(fid, "needs", pid));
  }
}

// backend / async work → the infra lens is drawn too (the flows job may have started before needs was known)
async function drawInfra(fid: string, pid: string, needs: FeatureNeeds | undefined) {
  if (!needs?.queues && !needs?.schema) return;
  const v0 = pieceOf(fid, pid);
  if (!v0 || v0.flowcharts.some((s) => s.lens === INFRA_LENS)) return;
  // let a running flows job (which may already include infra) finish first
  for (let i = 0; i < 120 && pieceOf(fid, pid)?.jobs?.some((j) => j.kind === "flows" && isActive(j)); i++)
    await new Promise((r) => setTimeout(r, 1000));
  const v1 = pieceOf(fid, pid);
  if (!v1 || v1.flowcharts.some((s) => s.lens === INFRA_LENS)) return;
  const set = await generateFlows(v1, INFRA_LENS).catch(() => null);
  if (set)
    await updateFeature(fid, (f) => {
      const p = f.pieces.find((x) => x.id === pid);
      if (p && !p.flowcharts.some((s) => s.lens === INFRA_LENS)) p.flowcharts.push(set);
    }).catch(() => undefined);
}

// sketch runs after the piece's stories (this run's, or one already running elsewhere): their startPaths are its routes
function runPiece(fid: string, pid: string, kinds: PieceJobKind[]) {
  const runs = new Map<PieceJobKind, Promise<unknown>>();
  for (const k of kinds)
    if (k !== "sketch") runs.set(k, k === "needs" ? needsCheck(fid, pid) : job(fid, k, pid, WORK[k](fid, pid)));
  if (kinds.includes("sketch"))
    runs.set(
      "sketch",
      (async () => {
        await runs.get("stories");
        await settled(fid, pid, "stories");
        await job(fid, "sketch", pid, WORK.sketch(fid, pid));
      })(),
    );
  return Promise.all(runs.values());
}

// wait (<= 5 min) until no `k` job is queued / running on the piece
async function settled(fid: string, pid: string, k: PieceJobKind) {
  for (let i = 0; i < 300 && pieceOf(fid, pid)?.jobs?.some((j) => j.kind === k && isActive(j)); i++)
    await new Promise((r) => setTimeout(r, 1000));
}

async function run(fid: string, plan: Plan) {
  if (plan.feature.includes("context")) await job(fid, "context", undefined, WORK.context(fid, ""));
  await Promise.all(plan.pieces.map((p) => runPiece(fid, p.pid, p.kinds)));
  await settlePhase(fid);
}

// shaping → ready once nothing is queued/running on the feature or any piece
async function settlePhase(fid: string) {
  await updateFeature(fid, (f) => {
    if (f.phase !== "shaping") return;
    const busy = [...(f.jobs ?? []), ...f.pieces.flatMap((p) => p.jobs ?? [])].some(isActive);
    if (!busy) f.phase = "ready";
  }).catch(() => undefined);
}

// ---------- stale sweep ----------

const alive = (pid?: number) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

// A queued/running job is stale when its process is gone, or it's ours but not live (server restarted
// with the same pid is impossible; HMR keeps `live` on globalThis).
const stale = (fid: string, j: Job, pid?: string) =>
  isActive(j) && (j.pid === process.pid ? !state.live.has(key(fid, j.kind, pid)) : !alive(j.pid));

const lists = (f: Feature) => [
  ...(f.jobs ?? []).map((j) => ({ j, pid: undefined as string | undefined })),
  ...f.pieces.flatMap((p) => (p.jobs ?? []).map((j) => ({ j, pid: p.id }))),
];

export async function sweepStale(fid?: string) {
  const hits = listFeatures().filter((f) => (!fid || f.id === fid) && lists(f).some(({ j, pid }) => stale(f.id, j, pid)));
  for (const h of hits) {
    await updateFeature(h.id, (f) => {
      let swept = false;
      for (const { j, pid } of lists(f))
        if (stale(f.id, j, pid)) {
          Object.assign(j, { status: "error", error: "interrupted — server restarted", finishedAt: now() });
          swept = true;
        }
      if (swept && f.phase === "shaping" && !lists(f).some(({ j }) => isActive(j))) f.phase = "ready";
    }).catch(() => undefined);
  }
}
