// Replay every migration over the baseline. Cached by (relpath, mtime, size): warm calls are a stat sweep.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, getSettings } from "../store";
import { applyOps, bare, cloneModel, emptyModel, touchedTables } from "./apply";
import { EffectCache, sha1, statOf } from "./cache";
import { renamesOf } from "./diff";
import { opsSummary, toErd } from "./graph";
import { humanize } from "./humanize";
import { listMigrations, type MigFile } from "./order";
import { type ParseResult, parseSqlSync, ready } from "./parse";
import { risk, worstOf } from "./risk";
import type { ErdGraph, MigrationMeta, MigrationView, SchemaHead, SchemaModel, SchemaOp } from "./types";

export interface ReplayCfg { repo: string; dirs: string[]; baseline: string; cacheFile?: string }

export interface Replayed {
  sig: string;
  files: MigFile[];
  effects: ParseResult[];
  metas: MigrationMeta[];
  base: SchemaModel; // baseline (before migration 0)
  checkpoints: SchemaModel[]; // checkpoints[k] = state before migration k*CP
  head: SchemaModel;
  history: Record<string, string[]>; // table -> migration ids that touched it
  hasBaseline: boolean;
  ms: number;
}

const CP = 32;
const expand = (p: string, repo: string) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : path.resolve(repo, p));

// in-process memo: last result + per-file hashes so changed files alone get re-read
let last: Replayed | null = null;
const hashes = new Map<string, { stamp: string; hash: string }>();
const caches = new Map<string, EffectCache>();

function effectOf(abs: string, cache: EffectCache): ParseResult {
  const st = statOf(abs);
  const stamp = st ? `${st.mtimeMs}:${st.size}` : "";
  let h = hashes.get(abs);
  let content: string | undefined;
  if (!h || h.stamp !== stamp) {
    content = fs.readFileSync(abs, "utf8");
    h = { stamp, hash: cache.key(content) };
    hashes.set(abs, h);
  }
  const hit = cache.get(h.hash);
  if (hit) return hit;
  const eff = parseSqlSync(content ?? fs.readFileSync(abs, "utf8"));
  cache.set(h.hash, eff);
  return eff;
}

const magnitude = (ops: SchemaOp[]) => Math.max(1, ops.filter((o) => o.op !== "txn" && o.op !== "comment" && o.op !== "guard").length);

function pick(m: SchemaModel, ids: string[]): SchemaModel {
  const tables: SchemaModel["tables"] = {};
  for (const id of ids) if (m.tables[id]) tables[id] = structuredClone(m.tables[id]);
  return { tables, views: [], functions: [] };
}

export async function replay(cfg: ReplayCfg): Promise<Replayed> {
  await ready();
  const t0 = performance.now();
  const files = listMigrations(cfg.repo, cfg.dirs);
  const basePath = cfg.baseline ? expand(cfg.baseline, cfg.repo) : "";
  const stamps = [basePath, ...files.map((f) => f.abs)].map((p) => {
    const st = p ? statOf(p) : null;
    return `${p}:${st?.mtimeMs ?? 0}:${st?.size ?? 0}`;
  });
  const sig = sha1(JSON.stringify([cfg.repo, cfg.dirs, files.map((f) => f.id), stamps]));
  if (last?.sig === sig) return last;

  const key = cfg.cacheFile ?? "";
  const cache = caches.get(key) ?? caches.set(key, new EffectCache(cfg.cacheFile)).get(key)!;

  const model = emptyModel();
  let hasBaseline = false;
  if (basePath && statOf(basePath)) {
    applyOps(model, effectOf(basePath, cache).ops, "baseline");
    for (const t of Object.values(model.tables)) { t.origin = "baseline"; delete t.createdIn; }
    hasBaseline = true;
  }
  const base = cloneModel(model);
  const checkpoints: SchemaModel[] = [];
  const effects: ParseResult[] = [];
  const metas: MigrationMeta[] = [];
  const history: Record<string, string[]> = {};

  files.forEach((f, i) => {
    if (i % CP === 0) checkpoints.push(cloneModel(model));
    const eff = effectOf(f.abs, cache);
    effects.push(eff);
    const touched = touchedTables(eff.ops, model);
    const renames = renamesOf(eff.ops).tables;
    const before = pick(model, [...touched, ...Object.values(renames)]);
    applyOps(model, eff.ops, f.id);
    const meta: MigrationMeta = {
      id: f.id, file: f.file, order: i, date: f.date, title: humanize(f.id), magnitude: magnitude(eff.ops), worst: null,
      tables: touched, dupPrefix: f.dupPrefix, dynamic: eff.ops.filter((o) => o.op === "dynamic").length,
      ...(eff.error && { parseError: `line ${eff.error.line}: ${eff.error.message}` }),
    };
    meta.worst = worstOf(risk(eff.ops, before, model, meta));
    metas.push(meta);
    for (const [to, from] of Object.entries(renames)) if (history[from]) { history[to] = [...history[from], ...(history[to] ?? [])]; delete history[from]; }
    for (const t of touched) (history[t] ??= []).push(f.id);
  });
  cache.save();
  last = { sig, files, effects, metas, base, checkpoints, head: model, history, hasBaseline, ms: Math.round(performance.now() - t0) };
  views.clear();
  return last;
}

// state after migration i (i = -1: baseline). From the nearest checkpoint: <= 31 folds.
export function modelAt(r: Replayed, i: number): SchemaModel {
  if (i < 0) return cloneModel(r.base);
  if (i >= r.files.length - 1) return cloneModel(r.head);
  const k = Math.floor((i + 1) / CP);
  const m = cloneModel(r.checkpoints[k]);
  for (let j = k * CP; j <= i; j++) applyOps(m, r.effects[j].ops, r.files[j].id);
  return m;
}

export function headOf(r: Replayed): SchemaHead {
  const last = new Map<string, string>();
  for (const [t, ids] of Object.entries(r.history)) last.set(t, ids[ids.length - 1]);
  const tables = Object.values(r.head.tables)
    .map((t) => {
      const label = bare(t.name);
      return {
        id: t.name, label, cols: t.columns.length, fks: t.fks.length, origin: t.origin,
        group: label.replace(/^_+/, "").split(/[_.]/)[0], ...(last.get(t.name) && { lastTouched: last.get(t.name) }),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  return {
    migrations: r.metas,
    tables,
    baseline: r.hasBaseline,
    stats: { files: r.files.length, tables: tables.length, parseErrors: r.metas.filter((m) => m.parseError).length, ms: r.ms },
  };
}

const views = new Map<string, MigrationView>();

export function migrationView(r: Replayed, id: string, withSql = false): MigrationView | null {
  const i = r.files.findIndex((f) => f.id === id);
  if (i < 0) return null;
  let v = views.get(id);
  if (!v) {
    const ops = r.effects[i].ops;
    const before = modelAt(r, i - 1);
    const after = applyOps(cloneModel(before), ops, id);
    const meta = r.metas[i];
    const risks = risk(ops, before, after, meta);
    v = { meta, graph: toErd(before, after, touchedTables(ops, before), risks, ops), opsSummary: opsSummary(ops) };
    if (views.size > 64) views.delete(views.keys().next().value!);
    views.set(id, v);
  }
  if (!withSql) return v;
  let sql = "";
  try { sql = fs.readFileSync(r.files[i].abs, "utf8"); } catch { /* deleted since the replay */ }
  return { ...v, sql };
}

export function tableView(r: Replayed, name: string): { graph: ErdGraph; history: string[] } | null {
  const id = name.includes(".") ? name : `public.${name}`;
  if (!r.head.tables[id]) return null;
  return { graph: toErd(r.head, r.head, [id], [], []), history: r.history[id] ?? [] };
}

// head with some migration files left out (uncommitted files are already in the replay)
function headWithout(r: Replayed, files: string[]): SchemaModel {
  const skip = new Set(files.map((f) => path.normalize(f)));
  if (!r.files.some((f) => skip.has(path.normalize(f.file)))) return r.head;
  const m = cloneModel(r.base);
  r.files.forEach((f, i) => { if (!skip.has(path.normalize(f.file))) applyOps(m, r.effects[i].ops, f.id); });
  return m;
}

// what a set of ops would do on top of the current head (minus `files` when they are those ops)
export function previewOps(r: Replayed, ops: SchemaOp[], meta: MigrationMeta, files: string[] = []): MigrationView {
  const before = headWithout(r, files);
  const after = applyOps(cloneModel(before), ops, meta.id);
  const risks = risk(ops, before, after, meta);
  const touched = touchedTables(ops, before);
  return { meta: { ...meta, worst: worstOf(risks), tables: touched }, graph: toErd(before, after, touched, risks, ops), opsSummary: opsSummary(ops) };
}

// ---------- bound to the user's settings ----------

export function settingsCfg(repo = getSettings().repoPath): ReplayCfg {
  const s = getSettings();
  return {
    repo,
    dirs: [s.migrationsDir, ...(s.extraMigrationDirs ?? [])].filter(Boolean),
    baseline: s.baselineSchemaPath ?? "",
    cacheFile: path.join(DATA_DIR, "cache", "schema", "effects-v1.json"),
  };
}
// the schema as it is on the base branch (settings.baseBranch, fetched): lambda's shared checkout, not the
// developer's working tree (an old local branch would hide newer migrations). no checkout yet / no repo →
// the working tree. "pick from repo" proposals still read the working tree's uncommitted files (git.ts).
async function schemaRepo(): Promise<string> {
  const { repoPath } = getSettings();
  if (!repoPath) return repoPath;
  const { prepareSharedWorktree } = await import("../intake"); // lazy: intake → jobs → schema
  const wt = await prepareSharedWorktree(repoPath, { fetch: true, move: true }).catch(() => null);
  return wt?.dir ?? repoPath;
}
export const current = async () => replay(settingsCfg(await schemaRepo()));
export const getHead = async () => headOf(await current());
export const getModelAt = async (i: number) => modelAt(await current(), i);
export const getMigrationView = async (id: string, sql = false) => migrationView(await current(), id, sql);
export const getTableView = async (name: string) => tableView(await current(), name);
