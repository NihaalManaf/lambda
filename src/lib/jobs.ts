import "server-only";
import { z } from "zod";
import { discoverContext, mergeDiscovered } from "./autocontext";
import { generateFlows } from "./flows";
import { featurePrompt, generate } from "./llm";
import { proposeFromPrompt as proposeQueues } from "./queues/propose";
import { proposeFromPrompt as proposeSchema } from "./schema/propose";
import { getFeature, listFeatures, now, updateFeature } from "./store";
import { generateStories, syncSlices } from "./stories";
import { INFRA_LENS, autoLenses, type Feature, type Job, type JobKind } from "./types";

// Background generation. In-process, never awaited by the request that starts it; status lives in
// feature.jobs so any tab (or a reload) sees progress. Order: context → stories ∥ flows ∥ needs → schema/queues.

export const JOB_KINDS: JobKind[] = ["context", "stories", "flows", "schema", "queues"];
const FULL: JobKind[] = ["context", "stories", "flows"];
const CONTEXT_BUDGET_MS = 25_000;

// survives HMR module reloads; one per process
const G = globalThis as { __lambdaJobs?: { live: Set<string>; detail: Map<string, { schema?: string; queues?: string }> } };
const state = (G.__lambdaJobs ??= { live: new Set(), detail: new Map() });
const key = (fid: string, k: JobKind) => `${fid}:${k}`;

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 140);

export const isActive = (j: Job) => j.status === "queued" || j.status === "running";

// Mark kinds queued on f (in place) unless already live here, or active under another live process
// (the installed app and `next dev` share one store). Returns accepted kinds.
function markQueued(f: Feature, kinds: JobKind[]): JobKind[] {
  const elsewhere = (k: JobKind) =>
    (f.jobs ?? []).some((j) => j.kind === k && isActive(j) && !!j.pid && j.pid !== process.pid && alive(j.pid));
  const accepted = [...new Set(kinds)].filter((k) => !state.live.has(key(f.id, k)) && !elsewhere(k));
  f.jobs = f.jobs ?? [];
  for (const k of accepted) {
    state.live.add(key(f.id, k));
    const j: Job = { kind: k, status: "queued", pid: process.pid };
    const i = f.jobs.findIndex((x) => x.kind === k);
    if (i >= 0) f.jobs[i] = j;
    else f.jobs.push(j);
  }
  return accepted;
}

// Sync, for callers already inside updateFeature (e.g. applyContextOp "rediscover").
// kinds omitted = the full pipeline (context, stories, flows + needs check → schema/queues).
export function queueJobsInPlace(f: Feature, kinds?: JobKind[]): JobKind[] {
  const full = !kinds;
  if (kinds?.includes("schema") || kinds?.includes("queues")) {
    f.needs = {
      schema: !!f.needs?.schema || kinds.includes("schema"),
      queues: !!f.needs?.queues || kinds.includes("queues"),
      why: f.needs?.why ?? "added by hand",
    };
  }
  const accepted = markQueued(f, kinds ?? FULL);
  if (accepted.length) setTimeout(() => void run(f.id, accepted, full), 0); // after the caller's lock
  return accepted;
}

export async function startJobs(fid: string, kinds?: JobKind[]): Promise<Feature> {
  return updateFeature(fid, (f) => void queueJobsInPlace(f, kinds));
}

// ---------- runner ----------

function setJob(fid: string, k: JobKind, patch: Partial<Job>) {
  return updateFeature(fid, (f) => {
    f.jobs = f.jobs ?? [];
    const j = f.jobs.find((x) => x.kind === k);
    if (j) Object.assign(j, patch);
    else f.jobs.push({ kind: k, status: "queued", ...patch });
  });
}

// One job: running → work (outside the lock) → commit + done (inside). Errors land on the job.
async function job(fid: string, k: JobKind, work: (f: Feature) => Promise<(f: Feature) => void>) {
  try {
    await setJob(fid, k, { status: "running", startedAt: now(), finishedAt: undefined, error: undefined, pid: process.pid });
    const f0 = getFeature(fid);
    if (!f0) throw new Error("feature gone");
    const commit = await work(f0);
    await updateFeature(fid, (f) => {
      commit(f);
      const j = f.jobs?.find((x) => x.kind === k);
      if (j) Object.assign(j, { status: "done", finishedAt: now() });
    });
  } catch (e) {
    await setJob(fid, k, { status: "error", error: short(e), finishedAt: now() }).catch(() => undefined);
  } finally {
    state.live.delete(key(fid, k));
  }
}

const WORK: Record<JobKind, (fid: string) => (f0: Feature) => Promise<(f: Feature) => void>> = {
  context: () => async (f0) => {
    const { refs, status } = await discoverContext(f0, { timeoutMs: CONTEXT_BUDGET_MS });
    return (f) => mergeDiscovered(f, refs, status);
  },
  stories: () => async (f0) => {
    const before = new Set(f0.stories.map((s) => s.id));
    const { sizing, stories } = await generateStories(f0);
    return (f) => {
      // story ops are refused while this job runs (applyOps); anything that still slipped in is kept,
      // along with the slices it points at
      const addedMeanwhile = f.stories.filter((s) => !before.has(s.id));
      const keptSlices = (f.sizing?.slices ?? []).filter(
        (sl) => !sizing.slices.some((n) => n.id === sl.id) && addedMeanwhile.some((st) => st.sliceId === sl.id),
      );
      f.stories = [...stories, ...addedMeanwhile];
      f.sizing = { ...sizing, slices: [...sizing.slices, ...keptSlices] };
      syncSlices(f);
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
  schema: (fid) => async (f0) => {
    const p = await proposeSchema(f0, state.detail.get(fid)?.schema || f0.needs?.why || f0.brief || f0.title);
    return (f) => void (f.schema = [...(f.schema ?? []), p]);
  },
  queues: (fid) => async (f0) => {
    const p = await proposeQueues(f0, state.detail.get(fid)?.queues || f0.needs?.why || f0.brief || f0.title);
    return (f) => void (f.queues = [...(f.queues ?? []), p]);
  },
};

const NeedsOut = z.object({
  schema: z.boolean().describe("feature adds/changes db tables, columns, indexes or enums"),
  queues: z.boolean().describe("feature adds/changes async jobs, queues, workers, crons or webhooks"),
  why: z.string().describe("<= 12 words"),
  schemaChange: z.string().describe("if schema: the db change in <= 25 words, else empty"),
  queueChange: z.string().describe("if queues: the async change in <= 25 words, else empty"),
});

// cheap relevance check → feature.needs, then the matching proposal jobs
async function needsCheck(fid: string) {
  try {
    const f0 = getFeature(fid);
    if (!f0) return;
    let needs = f0.needs;
    if (!needs) {
      const out = await generate({
        schema: NeedsOut,
        effort: "low",
        maxTokens: 800,
        prompt: `${featurePrompt(f0)}\n\ndoes building this feature change the database schema? does it add or change async work (queues, background jobs, crons, webhooks)? say false unless clearly needed.`,
      });
      needs = { schema: out.schema, queues: out.queues, why: out.why.split(/\s+/).slice(0, 12).join(" ") };
      state.detail.set(fid, { schema: out.schemaChange || undefined, queues: out.queueChange || undefined });
    }
    const kinds: JobKind[] = [
      ...(needs.schema && !f0.schema?.length ? (["schema"] as const) : []),
      ...(needs.queues && !f0.queues?.length ? (["queues"] as const) : []),
    ];
    let accepted: JobKind[] = [];
    const final = needs;
    await updateFeature(fid, (f) => {
      f.needs = f.needs ?? final;
      accepted = markQueued(f, kinds);
    });
    await Promise.all([...accepted.map((k) => job(fid, k, WORK[k](fid))), drawInfra(fid, needs)]);
  } catch {
    /* needs is optional: the ghost chips still let a person add schema/queues */
  } finally {
    state.detail.delete(fid);
  }
}

// backend / async work → the infra lens is drawn too (the flows job may have started before needs was known)
async function drawInfra(fid: string, needs: Feature["needs"]) {
  if (!needs?.queues && !needs?.schema) return;
  const f0 = getFeature(fid);
  if (!f0 || f0.flowcharts.some((s) => s.lens === INFRA_LENS)) return;
  // let a running flows job (which may already include infra) finish first
  for (let i = 0; i < 120 && getFeature(fid)?.jobs?.some((j) => j.kind === "flows" && isActive(j)); i++)
    await new Promise((r) => setTimeout(r, 1000));
  const f1 = getFeature(fid);
  if (!f1 || f1.flowcharts.some((s) => s.lens === INFRA_LENS)) return;
  const set = await generateFlows(f1, INFRA_LENS).catch(() => null);
  if (set)
    await updateFeature(fid, (f) => {
      if (!f.flowcharts.some((s) => s.lens === INFRA_LENS)) f.flowcharts.push(set);
    });
}

async function run(fid: string, kinds: JobKind[], full: boolean) {
  if (kinds.includes("context")) await job(fid, "context", WORK.context(fid));
  await Promise.all([
    ...kinds.filter((k) => k !== "context").map((k) => job(fid, k, WORK[k](fid))),
    ...(full ? [needsCheck(fid)] : []),
  ]);
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
const stale = (fid: string, j: Job) =>
  isActive(j) && (j.pid === process.pid ? !state.live.has(key(fid, j.kind)) : !alive(j.pid));

export async function sweepStale(fid?: string) {
  const hits = listFeatures().filter((f) => (!fid || f.id === fid) && f.jobs?.some((j) => stale(f.id, j)));
  for (const h of hits) {
    await updateFeature(h.id, (f) => {
      for (const j of f.jobs ?? [])
        if (stale(f.id, j)) Object.assign(j, { status: "error", error: "interrupted — server restarted", finishedAt: now() });
    }).catch(() => undefined);
  }
}
