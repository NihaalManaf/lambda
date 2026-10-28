import "server-only";
import { z } from "zod";
import { queueJobsInPlace } from "./jobs";
import { generate } from "./llm";
import type { ChangeNote, ContextOp } from "./ops";
import { linearIssues } from "./sources/linear";
import { getSessionDigest, listSessions } from "./sources/sessions";
import { slackMessages } from "./sources/slack";
import { clip } from "./sources/types";
import { id, now } from "./store";
import type { ContextRef, DiscoveryStatus, Feature } from "./types";

// Auto context: derive queries from the brief → search every source in parallel → dedupe → model ranks →
// attach the top few as ContextRef {auto, score, why}. Pinned refs (auto falsy) are never touched.

export const MAX_AUTO = 8;
export const MIN_SCORE = 0.5;
const PER_QUERY = 8;
const MAX_CANDIDATES = 48;

type Kind = ContextRef["kind"];
type Candidate = { key: string; kind: Kind; title: string; excerpt: string; url?: string; sessionId?: string };

const QueriesOut = z.object({
  queries: z.array(z.string()).describe("3-6 short search queries, 1-4 words each"),
  keywords: z.array(z.string()).describe("3-8 single distinctive words (product nouns, table/service names)"),
});

const RankOut = z.object({
  ranked: z.array(z.object({ i: z.number().int(), score: z.number(), why: z.string().describe("<= 8 words") })),
});

// Mask credentials before anything from slack / sessions is stored or sent to a model.
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/])/g, // long base64 / hex blobs
];
const SECRET_ASSIGN = /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;
export function redactSecrets(s: string): string {
  const masked = SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, "•••"), s);
  return masked.replace(SECRET_ASSIGN, (_m, k: string, sep: string) => `${k}${sep}•••`);
}

const words = (s: string, n: number) => s.trim().split(/\s+/).filter(Boolean).slice(0, n).join(" ");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const sameRef = (a: Pick<ContextRef, "kind" | "title" | "url">, b: Pick<ContextRef, "kind" | "title" | "url">) =>
  a.kind === b.kind && ((!!a.url && a.url === b.url) || norm(a.title) === norm(b.title));

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms))]);
}

async function deriveQueries(f: Feature): Promise<{ queries: string[]; keywords: string[] }> {
  const out = await generate({
    schema: QueriesOut,
    effort: "low",
    maxTokens: 1000,
    prompt: `feature: ${f.title}\n\nbrief:\n${f.brief || "(none)"}\n\nwrite search queries to find prior slack threads, linear issues and past coding sessions about this feature. prefer distinctive nouns over generic words.`,
  });
  const uniq = (xs: string[], n: number, w: number) => [...new Set(xs.map((x) => words(x, w).toLowerCase()).filter(Boolean))].slice(0, n);
  return { queries: uniq(out.queries, 6, 4), keywords: uniq(out.keywords, 8, 1) };
}

type SourceRun = { kind: Kind; ok: boolean; error?: string; items: Candidate[] };

async function searchSlack(queries: string[]): Promise<SourceRun> {
  const runs = await Promise.all(queries.map((q) => slackMessages(q, PER_QUERY)));
  const first = runs[0];
  if (first && !first.connected) return { kind: "slack", ok: false, error: first.error ?? "not connected", items: [] };
  const errs = runs.filter((r) => r.error);
  const items = runs.flatMap((r) =>
    r.items.map((m): Candidate => ({
      key: `slack:${m.id}`,
      kind: "slack",
      title: clip(`${m.channel} · ${m.text}`, 90),
      excerpt: m.text,
      url: m.permalink,
    })),
  );
  return { kind: "slack", ok: errs.length < runs.length, error: errs[0]?.error, items };
}

async function searchLinear(queries: string[]): Promise<SourceRun> {
  const runs = await Promise.all(queries.map((q) => linearIssues(q, PER_QUERY)));
  const first = runs[0];
  if (first && !first.connected) return { kind: "linear", ok: false, error: first.error ?? "not connected", items: [] };
  const errs = runs.filter((r) => r.error);
  const items = runs.flatMap((r) =>
    r.items.map((i): Candidate => ({
      key: `linear:${i.id}`,
      kind: "linear",
      title: `${i.identifier} ${i.title}`,
      excerpt: [i.state, i.description].filter(Boolean).join(" · "),
      url: i.url,
    })),
  );
  return { kind: "linear", ok: errs.length < runs.length, error: errs[0]?.error, items };
}

// sessions match by substring on prompt/project, so single keywords hit far better than phrases
async function searchSessions(terms: string[]): Promise<SourceRun> {
  const items = terms.flatMap((q) =>
    listSessions({ q, limit: PER_QUERY }).map((m): Candidate => {
      const where = m.project.split("/").slice(-2).join("/");
      // a session that never had a real first prompt (matched on its project path) is titled by where it ran
      const title = m.prompt === "(no prompt)" ? `session in ${where}` : m.prompt;
      return { key: `session:${m.id}`, kind: "session", title, excerpt: `${where} · ${m.messages} msgs`, sessionId: m.id };
    }),
  );
  return { kind: "session", ok: true, items };
}

function settle(p: Promise<SourceRun>, kind: Kind): Promise<SourceRun> {
  return p.catch((e: unknown) => ({ kind, ok: false, error: clip(e instanceof Error ? e.message : String(e), 120), items: [] }));
}

async function rank(f: Feature, cands: Candidate[]): Promise<Map<number, { score: number; why: string }>> {
  const list = cands.map((c, i) => `${i}. [${c.kind}] ${clip(c.title, 100)} — ${clip(c.excerpt, 160)}`).join("\n");
  const out = await generate({
    schema: RankOut,
    effort: "low",
    maxTokens: 3000,
    prompt: `feature: ${f.title}\n\nbrief:\n${f.brief || "(none)"}\n\ncandidate context:\n${list}\n\nscore each candidate's relevance to THIS feature, 0-1 (1 = directly about it, 0.5 = useful background, 0 = unrelated). only return candidates scoring >= 0.3. why: <= 8 words, concrete ("same signup form", "prior bug in billing webhook").`,
  });
  const m = new Map<number, { score: number; why: string }>();
  for (const r of out.ranked) {
    if (r.i < 0 || r.i >= cands.length || m.has(r.i)) continue;
    m.set(r.i, { score: Math.max(0, Math.min(1, r.score)), why: words(r.why, 8) });
  }
  return m;
}

// Search + rank. Pure w.r.t. the store: returns refs + per-source status; caller merges.
export async function discoverContext(f: Feature, opts: { timeoutMs?: number } = {}): Promise<{ refs: ContextRef[]; status: DiscoveryStatus }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 25_000);
  const left = () => Math.max(1000, deadline - Date.now());

  const { queries, keywords } = await withTimeout(deriveQueries(f), left(), "query planning");
  const sessionTerms = [...new Set([...keywords, ...queries.filter((q) => !q.includes(" "))])].slice(0, 8);

  // sources get at most ~half the remaining budget; ranking needs the rest
  const budget = Math.max(3000, Math.floor(left() * 0.55));
  const timed = (p: Promise<SourceRun>, kind: Kind) => settle(withTimeout(p, budget, kind), kind);
  const runs = await Promise.all([
    timed(searchSlack(queries), "slack"),
    timed(searchLinear(queries), "linear"),
    timed(Promise.resolve().then(() => searchSessions(sessionTerms)), "session"),
  ]);

  // nothing from third parties leaves this function (or reaches the ranker) unredacted
  for (const r of runs) for (const c of r.items) Object.assign(c, { title: redactSecrets(c.title), excerpt: redactSecrets(c.excerpt) });

  // dedupe: by source key, never re-suggest something already attached
  const seen = new Set<string>();
  const cands: Candidate[] = [];
  // round-robin across sources so one chatty source can't crowd out the rest
  const queues = runs.map((r) => [...r.items]);
  while (cands.length < MAX_CANDIDATES && queues.some((q) => q.length)) {
    for (const q of queues) {
      const c = q.shift();
      if (!c || seen.has(c.key)) continue;
      seen.add(c.key);
      if (f.context.some((r) => !r.auto && sameRef(r, c))) continue;
      if ((f.contextDismissed ?? []).some((d) => sameRef(d, c))) continue; // detached by the developer
      cands.push(c);
    }
  }

  const status: DiscoveryStatus = {
    at: now(),
    queries,
    sources: runs.map((r) => ({ kind: r.kind, ok: r.ok, found: r.items.length, ...(r.error ? { error: r.error } : {}) })),
  };
  if (!cands.length) return { refs: [], status };

  const scores = await withTimeout(rank(f, cands), left(), "ranking");
  const top = [...scores.entries()]
    .filter(([, s]) => s.score >= MIN_SCORE)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, MAX_AUTO);

  const refs = top.map(([i, s]): ContextRef => {
    const c = cands[i];
    let excerpt = c.excerpt;
    if (c.sessionId) {
      try {
        excerpt = getSessionDigest(c.sessionId)?.excerpt || excerpt; // tail read, cheap
      } catch {
        /* keep meta excerpt */
      }
    }
    return {
      id: id("ctx"),
      kind: c.kind,
      title: clip(c.title, 140),
      excerpt: clip(redactSecrets(excerpt), 400),
      ...(c.url && /^https?:\/\//.test(c.url) ? { url: c.url } : {}),
      auto: true,
      score: Math.round(s.score * 100) / 100,
      why: s.why,
    };
  });
  return { refs, status };
}

// Merge a discovery result: pinned refs stay, previous auto refs are replaced, no duplicates.
export function mergeDiscovered(f: Feature, refs: ContextRef[], status: DiscoveryStatus) {
  const pinned = f.context.filter((r) => !r.auto);
  const gone = f.contextDismissed ?? [];
  f.context = [...pinned, ...refs.filter((r) => !pinned.some((p) => sameRef(p, r)) && !gone.some((d) => sameRef(d, r)))];
  f.discovery = status;
}

const KINDS: Kind[] = ["slack", "linear", "session", "note"];

// Context ops (chat + direct manipulation). Mutates in place inside updateFeature.
// attach of something already attached = pin it (auto → false, keeps score/why).
// rediscover schedules the background context job (never holds the store lock for LLM calls).
export function applyContextOp(f: Feature, op: ContextOp): ChangeNote {
  switch (op.op) {
    case "attach": {
      const kind = KINDS.includes(op.kind) ? op.kind : "note";
      const title = clip(op.title ?? "", 140);
      if (!title) throw new Error("context needs a title");
      const url = op.url && /^https?:\/\//.test(op.url) ? clip(op.url, 500) : undefined;
      if (f.contextDismissed?.length) f.contextDismissed = f.contextDismissed.filter((d) => !sameRef(d, { kind, title, url }));
      const hit = f.context.find((r) => sameRef(r, { kind, title, url }));
      if (hit) {
        hit.auto = false;
        return { sign: "~", what: "context", label: `pinned ${words(hit.title, 4)}`, tab: "context", ref: hit.id };
      }
      const ref: ContextRef = { id: id("ctx"), kind, title, excerpt: clip(op.excerpt ?? "", 400), ...(url ? { url } : {}) };
      f.context.push(ref);
      return { sign: "+", what: "context", label: words(title, 6), tab: "context", ref: ref.id };
    }
    case "detach": {
      const hit = f.context.find((r) => r.id === op.refId);
      if (!hit) throw new Error(`context ${op.refId} not found`);
      f.context = f.context.filter((r) => r.id !== op.refId);
      if (hit.auto) {
        const tomb = { kind: hit.kind, title: hit.title, ...(hit.url ? { url: hit.url } : {}) };
        f.contextDismissed = [...(f.contextDismissed ?? []).filter((d) => !sameRef(d, tomb)), tomb].slice(-100);
      }
      return { sign: "−", what: "context", label: words(hit.title, 6), tab: "context", ref: hit.id };
    }
    case "rediscover": {
      queueJobsInPlace(f, ["context"]); // marks queued now (persisted by this write), runs after the lock
      return { sign: "~", what: "context", label: "rediscovering context", tab: "context" };
    }
  }
}
