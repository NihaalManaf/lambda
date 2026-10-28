import "server-only";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { secret } from "../env";
import { generate } from "../llm";
import { DATA_DIR, getSettings } from "../store";
import { link } from "./link";
import { RouteIndex } from "./routes";
import { langOf, sha1, snippet } from "./scan";
import type { NormFile, RawScan, Topology } from "./types";

// LLM pass, per file, only where the deterministic pass left a gap (unresolved target, unknown idempotency).
// Cached by sha1(content + PROMPT_VERSION): a rescan only pays for changed files. Deterministic values always win.

export const PROMPT_VERSION = "queues-norm-1";
const FILE = path.join(DATA_DIR, "cache", "queues", "norm-v1.json");
const CONCURRENCY = 6;

const IDEM = ["lock", "on-conflict", "dedup-check", "version", "none", "unknown"] as const;
const Out = z.object({
  publishes: z.array(
    z.object({
      symbol: z.string().describe("enclosing function name"),
      line: z.number(),
      channelKey: z.string().nullable().describe("route path the message is delivered to, e.g. /v1/x/process; sqs queue name; null if unknowable"),
    }),
  ),
  consumers: z.array(
    z.object({
      symbol: z.string(),
      line: z.number(),
      route: z.string().nullable(),
      idempotency: z.enum(IDEM).describe("how a redelivered message is made harmless; none = it would redo side effects"),
      retryAware: z.boolean().describe("reads upstash-retried / attempt count"),
      nonRetryable: z.boolean().describe("returns 489 / Upstash-NonRetryable-Error for poison input"),
    }),
  ),
});

const SYSTEM = `
you read backend code and fill gaps in a queue map. answer only from the code shown; never guess wildly.
- publishes: for each listed publish site, the route path (or sqs queue) the message reaches. use the route list when a builder/constant hides it. null if unknowable.
- consumers: for each listed handler, how it survives redelivery: lock (advisory lock / for update / mutex), on-conflict (upsert), dedup-check (checks a processed marker first), version (generation/version compare), none (re-runs side effects), unknown.
`.trim();

type Cache = Record<string, NormFile>;
const readCache = (): Cache => {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as Cache;
  } catch {
    return {};
  }
};
const writeCache = (c: Cache) => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(c));
  fs.renameSync(`${FILE}.tmp`, FILE);
};

interface Job { file: string; key: string; text: string; sites: number[]; handlers: { fn: string; line: number; route?: string }[] }

// files with gaps, from a deterministic link of the raw scan
function jobs(raw: RawScan, topo: Pick<Topology, "channels" | "consumers">, repo: string): Job[] {
  const by = new Map<string, Job>();
  const get = (file: string) => {
    if (!by.has(file)) {
      let text = "";
      try {
        text = fs.readFileSync(path.join(repo, file), "utf8");
      } catch {
        return null;
      }
      by.set(file, { file, key: sha1(text + PROMPT_VERSION), text, sites: [], handlers: [] });
    }
    return by.get(file)!;
  };
  for (const c of topo.channels) {
    const m = /^\?(.+):(\d+)$/.exec(c.key);
    if (m) get(m[1])?.sites.push(Number(m[2]));
  }
  for (const k of topo.consumers) if (k.idempotency === "unknown" && k.line > 0 && /\.(py|tsx?|go)$/.test(k.file)) get(k.file)?.handlers.push({ fn: k.symbol, line: k.line, route: k.route });
  return [...by.values()].filter((j) => j.sites.length || j.handlers.length);
}

export function cachedNorm(raw: RawScan): Record<string, NormFile> {
  const cache = readCache();
  const out: Record<string, NormFile> = {};
  for (const j of jobs(raw, link(raw), getSettings().repoPath)) if (cache[j.key]) out[j.file] = cache[j.key];
  return out;
}

function prompt(j: Job, routes: string[]): string {
  const lang = langOf(j.file);
  const parts = [
    ...j.sites.map((l) => `## publish site line ${l}\n${snippet(j.text, l, lang)}`),
    ...j.handlers.map((h) => `## handler ${h.fn} (route ${h.route ?? "?"}) line ${h.line}\n${snippet(j.text, h.line, lang)}`),
  ];
  const segs = new Set(j.text.match(/[a-z][a-z0-9_-]{3,}/g) ?? []);
  const rel = routes.filter((r) => r.split("/").some((s) => segs.has(s))).slice(0, 150);
  return `file: ${j.file}\n\n${parts.join("\n\n").split("\n").slice(0, 400).join("\n")}\n\nknown routes:\n${rel.join("\n")}`;
}

export async function normalize(raw: RawScan, topo: Topology, repo: string, onProgress: (done: number, total: number) => void): Promise<Record<string, NormFile>> {
  const cache = readCache();
  const all = jobs(raw, topo, repo);
  const out: Record<string, NormFile> = {};
  const todo: Job[] = [];
  for (const j of all) {
    if (cache[j.key]) out[j.file] = cache[j.key];
    else todo.push(j);
  }
  onProgress(0, todo.length);
  if (!todo.length || !secret("ANTHROPIC_API_KEY")) return out;
  const routes = new RouteIndex(raw.routes).paths();
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const j = todo[next++];
      try {
        const r = await generate({ schema: Out, system: SYSTEM, prompt: prompt(j, routes), effort: "low", maxTokens: 3000 });
        const nf: NormFile = {
          publishes: r.publishes.map((p) => ({ symbol: p.symbol, line: p.line, channelKey: p.channelKey, opts: {} })),
          consumers: r.consumers.map((c) => ({ ...c })),
        };
        cache[j.key] = nf;
        out[j.file] = nf;
      } catch {
        // one bad file never stops the scan
      }
      onProgress(++done, todo.length);
      if (done % 12 === 0) writeCache(cache);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  writeCache(cache);
  return out;
}
