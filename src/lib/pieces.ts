import { nanoid } from "nanoid";
import {
  isFeatureJobKind,
  type Brief,
  type Feature,
  type FeatureStatus,
  type FeatureView,
  type Job,
  type Piece,
  type PieceArtifacts,
  type Sizing,
  type Story,
} from "./types";

// Feature → pieces. Pure (client + server). A piece = one shippable PR; every build artifact belongs to one.
// Tabs, generators and ops keep working on a Feature-shaped projection of one piece (pieceView) and
// write it back (mergePieceView on the client, withPiece in place on the server).

export const ARTIFACT_KEYS = ["stories", "flowcharts", "mockups", "runs", "schema", "queues", "needs"] as const;

const newPieceId = () => `pc_${nanoid(8)}`;

const emptyArtifacts = (): PieceArtifacts => ({ stories: [], flowcharts: [], mockups: [], runs: [], schema: [], queues: [] });

export function makePiece(p: { title: string; why?: string; scope?: string[]; order?: number; status?: FeatureStatus; id?: string }): Piece {
  return {
    id: p.id ?? newPieceId(),
    order: p.order ?? 1,
    title: p.title,
    why: p.why ?? "",
    ...(p.scope?.length ? { scope: p.scope } : {}),
    status: p.status ?? "shaping",
    ...emptyArtifacts(),
  };
}

export const sortPieces = (ps: Piece[]) => [...ps].sort((a, b) => a.order - b.order);

export const firstPiece = (f: Pick<Feature, "pieces">): Piece | undefined => sortPieces(f.pieces ?? [])[0];

export const findPiece = (f: Pick<Feature, "pieces">, pieceId?: string | null): Piece | undefined =>
  pieceId ? f.pieces.find((p) => p.id === pieceId) : firstPiece(f);

// The feature's first piece, created (titled after the feature) if it has none. Mutates f.
export function ensurePiece(f: Feature): Piece {
  const p = firstPiece(f);
  if (p) return p;
  const made = makePiece({ title: f.title, order: 1, status: f.status });
  f.pieces = [made];
  return made;
}

// Pieces from a settled intake brief (1..5, ordered).
export function piecesFromBrief(brief: Pick<Brief, "pieces">): Piece[] {
  const src = brief.pieces.length ? brief.pieces.slice(0, 5) : [{ title: "whole feature", why: "", scope: [] }];
  return src.map((p, i) => makePiece({ title: p.title, why: p.why, scope: p.scope, order: i + 1 }));
}

export const isView = (x: Feature | FeatureView): x is FeatureView => typeof (x as FeatureView).pieceId === "string";

// ---------- projection ----------

// Feature-shaped object whose stories/flowcharts/mockups/runs/schema/queues/needs are the piece's (first
// piece when pieceId is omitted/unknown) and whose jobs = feature-level + the piece's. Arrays are shared,
// not copied: mutate in place or reassign, then write back. No piece at all → empty artifacts, pieceId "".
export function pieceView(f: Feature, pieceId?: string | null): FeatureView {
  const base: Feature = isView(f as FeatureView) ? stripView(f as FeatureView) : f;
  const p = findPiece(base, pieceId) ?? firstPiece(base);
  const art: PieceArtifacts = p
    ? { stories: p.stories, flowcharts: p.flowcharts, mockups: p.mockups, runs: p.runs, schema: p.schema, queues: p.queues, needs: p.needs }
    : emptyArtifacts();
  const jobs = [...(base.jobs ?? []), ...(p?.jobs ?? [])];
  return { ...base, ...art, jobs, pieceId: p?.id ?? "", sizing: undefined };
}

// Drop the projection fields from a view (artifacts are NOT written back — see mergePieceView).
function stripView(v: FeatureView): Feature {
  const { pieceId: _p, sizing: _s, stories: _a, flowcharts: _b, mockups: _c, runs: _d, schema: _e, queues: _f, needs: _g, ...rest } = v;
  void [_p, _s, _a, _b, _c, _d, _e, _f, _g];
  return { ...rest, jobs: (rest.jobs ?? []).filter((j) => isFeatureJobKind(j.kind)) };
}

const pieceJobs = (jobs: Job[] | undefined) => (jobs ?? []).filter((j) => !isFeatureJobKind(j.kind));

// Write a (possibly edited) view of `pieceId` back into a new Feature. `view` may also be a plain stored
// Feature (e.g. straight from GET /api/features): then it simply replaces f. The view's own `pieces` (fresh
// from the server, say) win over f's for every other piece.
export function mergePieceView(f: Feature, pieceId: string, view: Feature | FeatureView): Feature {
  if (!isView(view)) return migrateFeature(view);
  const rest = stripView(view);
  const pieces = rest.pieces ?? f.pieces;
  const pid = pieceId || view.pieceId;
  if (!pid || !pieces.some((p) => p.id === pid)) return { ...rest, pieces };
  return { ...rest, pieces: pieces.map((p) => (p.id === pid ? withArtifacts(p, view) : p)) };
}

// the piece with the view's artifacts + piece-level jobs (unset optionals stay absent, not `undefined`)
function withArtifacts(p: Piece, v: FeatureView): Piece {
  const next: Piece = { ...p };
  for (const k of ARTIFACT_KEYS) {
    if (v[k] === undefined) delete next[k];
    else (next as unknown as Record<string, unknown>)[k] = v[k];
  }
  const jobs = pieceJobs(v.jobs);
  if (jobs.length || p.jobs) next.jobs = jobs;
  return next;
}

// Server: run fn on a view of the piece (first piece, created if missing, when pieceId is omitted) and
// write it back into f IN PLACE (call inside updateFeature). Async fns write back once resolved.
// Throws when pieceId names no piece.
export function withPiece<T>(f: Feature, pieceId: string | null | undefined, fn: (view: FeatureView) => T): T {
  const piece = pieceId ? f.pieces.find((p) => p.id === pieceId) : ensurePiece(f);
  if (!piece) throw new Error(`piece ${pieceId} not found`);
  const view = pieceView(f, piece.id);
  const write = () => {
    const merged = mergePieceView(f, piece.id, view);
    for (const k of Object.keys(f) as (keyof Feature)[]) if (!(k in merged)) delete f[k];
    Object.assign(f, merged);
  };
  const out = fn(view);
  if (out && typeof (out as { then?: unknown }).then === "function")
    return (out as unknown as Promise<unknown>).then((r) => (write(), r)) as T;
  write();
  return out;
}

// ---------- moving work between pieces (in place) ----------

// a piece with a queued / running generation job (of `kinds`, or any)
export const pieceBusy = (p: Piece, kinds?: string[]) =>
  (p.jobs ?? []).some((j) => (j.status === "queued" || j.status === "running") && (!kinds || kinds.includes(j.kind)));

// Moves stories (by id; all of from's when omitted) from → to. Their browser runs travel with them.
export function moveStories(from: Piece, to: Piece, storyIds?: string[]): Story[] {
  if (from.id === to.id) return [];
  const ids = new Set(storyIds ?? from.stories.map((s) => s.id));
  const moving = from.stories.filter((s) => ids.has(s.id));
  if (!moving.length) return [];
  from.stories = from.stories.filter((s) => !ids.has(s.id));
  to.stories = [...to.stories, ...moving.map((s) => ({ ...s, sliceId: undefined }))];
  const runs = from.runs.filter((r) => ids.has(r.storyId));
  if (runs.length) {
    from.runs = from.runs.filter((r) => !ids.has(r.storyId));
    to.runs = [...to.runs, ...runs];
  }
  return moving;
}

// ---------- lookups across pieces ----------

export const allStories = (f: Pick<Feature, "pieces">): Story[] => (f.pieces ?? []).flatMap((p) => p.stories);
export const allRuns = (f: Pick<Feature, "pieces">) => (f.pieces ?? []).flatMap((p) => p.runs);
export const pieceOf = (f: Pick<Feature, "pieces">, pred: (p: Piece) => boolean): Piece | undefined => (f.pieces ?? []).find(pred);
export const pieceOfStory = (f: Pick<Feature, "pieces">, storyId: string) => pieceOf(f, (p) => p.stories.some((s) => s.id === storyId));
export const pieceOfRun = (f: Pick<Feature, "pieces">, runId: string) => pieceOf(f, (p) => p.runs.some((r) => r.id === runId));
export const pieceOfMockup = (f: Pick<Feature, "pieces">, mockupId: string) => pieceOf(f, (p) => p.mockups.some((m) => m.id === mockupId));
export const pieceOfFlowSet = (f: Pick<Feature, "pieces">, setId: string) => pieceOf(f, (p) => p.flowcharts.some((s) => s.id === setId));
export const pieceOfSchema = (f: Pick<Feature, "pieces">, pid: string) => pieceOf(f, (p) => !!p.schema?.some((x) => x.id === pid));
export const pieceOfQueue = (f: Pick<Feature, "pieces">, pid: string) => pieceOf(f, (p) => !!p.queues?.some((x) => x.id === pid));

// ?piece=<id> or body.pieceId (string, sane) → piece id, else undefined (= first piece).
export function pieceIdFrom(url: string, body?: unknown): string | undefined {
  const q = new URL(url).searchParams.get("piece");
  const b = body && typeof body === "object" ? (body as { pieceId?: unknown }).pieceId : undefined;
  const v = q || (typeof b === "string" ? b : "");
  return /^[\w-]{1,64}$/.test(v) ? v : undefined;
}

// ---------- migration (store read path) ----------

type Legacy = Partial<PieceArtifacts> & { sizing?: Sizing; jobs?: Job[] };

// deterministic ids: a migrated-but-not-yet-written feature must give the same piece ids on every read
const legacyPieceId = (fid: string, sliceId?: string) => `pc_${(sliceId ?? fid).replace(/^(sl|ft)_/, "")}`;

const byId = <T extends { id: string }>(into: T[], more: T[]) => [...into, ...more.filter((m) => !into.some((x) => x.id === m.id))];

// Old features (top-level arrays + sizing slices) → pieces. Idempotent; never drops data:
// - sizing.verdict "split" with 2+ slices → one piece per slice (stories by sliceId, unsliced → piece 1;
//   runs follow their story; flows / mockups / schema / queues / needs → piece 1)
// - otherwise → one piece with everything. Migrated features are phase "ready".
// - an already-migrated feature that grew stray top-level arrays (an old process wrote it) folds them into piece 1.
export function migrateFeature(raw: Feature): Feature {
  const r = raw as Feature & Legacy;
  const legacy: Legacy = { stories: r.stories, flowcharts: r.flowcharts, mockups: r.mockups, runs: r.runs, schema: r.schema, queues: r.queues, needs: r.needs, sizing: r.sizing };
  const hasLegacy = ARTIFACT_KEYS.some((k) => k in r) || "sizing" in r;
  const migrated = Array.isArray(r.pieces);
  if (migrated && !hasLegacy && r.phase && r.pieces.every((p) => Array.isArray(p.stories))) return raw;

  const out: Feature & Legacy = { ...r };
  for (const k of [...ARTIFACT_KEYS, "sizing"] as const) delete out[k];
  out.phase = r.phase ?? "ready";
  const allJobs = r.jobs ?? [];
  out.jobs = allJobs.filter((j) => isFeatureJobKind(j.kind));
  const legacyPieceJobs = pieceJobs(allJobs);

  let pieces: Piece[] = (migrated ? r.pieces : []).map((p) => ({ ...emptyArtifacts(), ...p }));
  const stories = legacy.stories ?? [];
  if (!pieces.length) {
    const slices = legacy.sizing?.verdict === "split" && legacy.sizing.slices.length > 1 ? legacy.sizing.slices : [];
    pieces = slices.length
      ? slices.map((sl, i) =>
          makePiece({ id: legacyPieceId(r.id, sl.id), title: sl.title, why: sl.why, order: i + 1, status: r.status }),
        )
      : [makePiece({ id: legacyPieceId(r.id), title: r.title, why: "", order: 1, status: r.status })];
    const pieceForSlice = new Map(slices.map((sl, i) => [sl.id, pieces[i]]));
    for (const st of stories) (pieceForSlice.get(st.sliceId ?? "") ?? pieces[0]).stories.push(st);
  } else {
    // stray arrays from an old process: only what no piece holds yet (a story moved to piece 3 stays there)
    const p0 = sortPieces(pieces)[0];
    p0.stories = byId(p0.stories, stories.filter((st) => !pieces.some((p) => p.stories.some((x) => x.id === st.id))));
  }
  const p0 = sortPieces(pieces)[0];
  for (const run of legacy.runs ?? []) {
    if (pieces.some((p) => p.runs.some((x) => x.id === run.id))) continue;
    (pieces.find((p) => p.stories.some((s) => s.id === run.storyId)) ?? p0).runs.push(run);
  }
  const fresh = <T extends { id: string }>(xs: T[] | undefined, held: (p: Piece) => T[] | undefined) =>
    (xs ?? []).filter((x) => !pieces.some((p) => (held(p) ?? []).some((y) => y.id === x.id)));
  p0.flowcharts = byId(p0.flowcharts, fresh(legacy.flowcharts, (p) => p.flowcharts));
  p0.mockups = byId(p0.mockups, fresh(legacy.mockups, (p) => p.mockups));
  p0.schema = byId(p0.schema ?? [], fresh(legacy.schema, (p) => p.schema));
  p0.queues = byId(p0.queues ?? [], fresh(legacy.queues, (p) => p.queues));
  if (legacy.needs && !p0.needs) p0.needs = legacy.needs;
  if (legacyPieceJobs.length) p0.jobs = [...(p0.jobs ?? []).filter((j) => !legacyPieceJobs.some((l) => l.kind === j.kind)), ...legacyPieceJobs];
  out.pieces = pieces;
  return out;
}
