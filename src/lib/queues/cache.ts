import "server-only";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, getSettings } from "../store";
import { link } from "./link";
import { setAppHosts } from "./resolve";
import { cachedNorm, normalize } from "./normalize";
import { toTopology } from "./ops";
import { extract, sha1 } from "./scan";
import type { NormFile, RawScan, ScanStatus, Topology } from "./types";

// Topology cache: memory + DATA_DIR/cache/queues/{topology,raw}.json. One background scan at a time.

const DIR = path.join(DATA_DIR, "cache", "queues");
const TOPO = path.join(DIR, "topology.json");
const RAW = path.join(DIR, "raw.json");

// bump when extraction or linking changes so an old cache reads as stale
export const ENGINE = 2;

let status: ScanStatus = { state: "idle", done: 0, total: 0 };
let mem: { topo: Topology; raw: RawScan } | null = null;
let running: Promise<void> | null = null;

const read = <T>(f: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as T;
  } catch {
    return null;
  }
};
const write = (f: string, v: unknown) => {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v));
  fs.renameSync(tmp, f);
};

export const getStatus = (): ScanStatus => status;

function load() {
  if (mem) return mem;
  const topo = read<Topology>(TOPO);
  const raw = read<RawScan>(RAW);
  if (topo && raw) mem = { topo, raw };
  return mem;
}
export const getTopology = (): Topology | null => load()?.topo ?? null;
export const getRaw = (): RawScan | null => load()?.raw ?? null;

// signature over (relpath, mtime, size) of the files that had hits
export const sigOf = (files: RawScan["files"]) => sha1(files.map((f) => `${f.file}|${Math.round(f.mtime)}|${f.size}`).join("\n"));

// cheap staleness check: re-stat the known hit files (new files show up on the next scan)
export function isStale(): boolean {
  const raw = getRaw();
  if (!raw || raw.v !== ENGINE) return true;
  const repo = getSettings().repoPath;
  return raw.files.some((f) => {
    try {
      const st = fs.statSync(path.join(repo, f.file));
      return Math.round(st.mtimeMs) !== Math.round(f.mtime) || st.size !== f.size;
    } catch {
      return true;
    }
  });
}

export async function buildTopology(raw: RawScan, norm: Record<string, NormFile> = {}): Promise<Topology> {
  setAppHosts(getSettings().appHosts ?? []);
  return toTopology(link(raw, norm), { sig: sigOf(raw.files), files: raw.files.length });
}

// Starts a scan in the background (no-op if one is running) and returns the status right away.
export function startScan(opts: { llm?: boolean } = {}): ScanStatus {
  if (running) return status;
  status = { state: "scanning", done: 0, total: 0 };
  running = (async () => {
    try {
      const { repoPath, queueIgnore } = getSettings();
      if (!fs.existsSync(repoPath)) throw new Error("repo not found: check settings");
      const raw = { ...(await extract(repoPath, queueIgnore ?? [])), v: ENGINE };
      // deterministic result first: the page has something to draw while the model fills gaps
      let topo = await buildTopology(raw);
      mem = { topo, raw };
      write(TOPO, topo);
      write(RAW, raw);
      if (opts.llm !== false) {
        status = { state: "normalizing", done: 0, total: 0 };
        const norm = await normalize(raw, topo, repoPath, (done, total) => (status = { state: "normalizing", done, total }));
        if (Object.keys(norm).length) {
          topo = await buildTopology(raw, norm);
          mem = { topo, raw };
          write(TOPO, topo);
        }
      }
      status = { state: "done", done: status.total, total: status.total };
    } catch (e) {
      status = { state: "error", done: 0, total: 0, error: e instanceof Error ? e.message : "scan failed" };
    } finally {
      running = null;
    }
  })();
  return status;
}

// Fresh topology for a request that needs one (proposals): reuse when nothing changed.
export async function ensureTopology(): Promise<{ topo: Topology; raw: RawScan }> {
  const cur = load();
  if (cur && !isStale()) return cur;
  if (running) await running;
  const again = load();
  if (again && !isStale()) return again;
  const { repoPath, queueIgnore } = getSettings();
  const raw = { ...(await extract(repoPath, queueIgnore ?? [])), v: ENGINE };
  const topo = await buildTopology(raw, cachedNorm(raw)); // LLM fill-ins already on disk, no new calls
  mem = { topo, raw };
  write(TOPO, topo);
  write(RAW, raw);
  return mem;
}
