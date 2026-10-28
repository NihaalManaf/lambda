// Repo walk + the non-python extractors (TS/Go), enclosing-function snippets, and the regex fallback
// used when python3 is missing. No server-only: tests import it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { depsFrom, infraFrom } from "./infra";
import { runPyScan, type PyOut } from "./pyscan";
import type { Kw, Mark, RawLambda, RawRoute, RawScan, RawSite } from "./types";

export const EXTS = [".py", ".ts", ".tsx", ".go", ".yaml", ".yml"];
// spec list + Go SQS lambda entrypoints (events.SQSEvent) so Go consumers are seen
export const PREFILTER = /QStash|qstash|batch_enqueue|CronJob\(|send_message|SendMessageBatch|Receiver\(|verify_qstash_sig|AWS::SQS|EventSourceMapping|lambda_handler|schedule:|cron\(|events\.SQSEvent/;
const ALWAYS_SKIP = new Set(["site-packages", "tests", "test", "__tests__"]);

export const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

export function walk(repo: string, ignore: string[], exts = EXTS): string[] {
  const skip = new Set([...ignore, ...ALWAYS_SKIP]);
  const out: string[] = [];
  const rec = (dir: string) => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(path.join(repo, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skip.has(e.name) && !e.name.startsWith(".")) rec(rel);
      } else if (e.isFile() && exts.some((x) => e.name.endsWith(x)) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(rel);
    }
  };
  rec("");
  return out;
}

export interface Hit { file: string; text: string; sha: string; mtime: number; size: number }

// Files that mention a queue primitive. .github workflows are hidden dirs: added explicitly.
// overrides (git HEAD replay): repo-rel -> text, or null when the file did not exist.
export function hitFiles(repo: string, ignore: string[], overrides: Record<string, string | null> = {}, all: string[] = []): Hit[] {
  const gh = (() => {
    try {
      return fs.readdirSync(path.join(repo, ".github/workflows")).filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`);
    } catch {
      return [];
    }
  })();
  const out: Hit[] = [];
  const files = [...walk(repo, ignore), ...gh];
  all.push(...files);
  for (const f of Object.keys(overrides)) if (!files.includes(f) && EXTS.some((x) => f.endsWith(x))) files.push(f);
  for (const file of files) {
    const abs = path.join(repo, file);
    let text: string;
    let st: { mtimeMs: number; size: number };
    try {
      if (file in overrides) {
        if (overrides[file] == null) continue;
        text = overrides[file]!;
        st = { mtimeMs: 0, size: text.length };
      } else {
        st = fs.statSync(abs);
        if (st.size > 2_000_000) continue;
        text = fs.readFileSync(abs, "utf8");
      }
    } catch {
      continue;
    }
    if (PREFILTER.test(text)) out.push({ file, text, sha: sha1(text), mtime: st.mtimeMs, size: st.size });
  }
  return out;
}

export const langOf = (file: string): RawSite["lang"] => (file.endsWith(".go") ? "go" : /\.tsx?$/.test(file) ? "ts" : "py");

// ---------- enclosing function snippet (<= 80 lines) ----------

export function enclosing(text: string, line: number, lang: RawSite["lang"]): { start: number; end: number; name: string } {
  const lines = text.split("\n");
  const i0 = Math.min(Math.max(line - 1, 0), lines.length - 1);
  if (lang === "py") {
    const ind = (s: string) => s.length - s.trimStart().length;
    let s = i0;
    let cur = ind(lines[i0]);
    for (let i = i0; i >= 0; i--) {
      const m = /^(\s*)(?:async\s+)?def\s+(\w+)/.exec(lines[i]);
      if (m && (i === i0 || m[1].length < cur)) {
        s = i;
        break;
      }
      if (lines[i].trim() && !lines[i].trim().startsWith("@")) cur = Math.min(cur, ind(lines[i]));
      if (i === 0) s = i0;
    }
    const base = ind(lines[s]);
    let e = s + 1;
    while (e < lines.length && (!lines[e].trim() || ind(lines[e]) > base)) e++;
    const name = /def\s+(\w+)/.exec(lines[s])?.[1] ?? "";
    return { start: s + 1, end: Math.min(e, s + 80), name };
  }
  const fnRx = lang === "go" ? /^func\s+(?:\([^)]*\)\s*)?(\w+)/ : /(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(|^\s*(?:export\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{)/;
  let s = i0;
  for (let i = i0; i >= 0; i--) {
    if (fnRx.test(lines[i])) {
      s = i;
      break;
    }
  }
  let depth = 0;
  let opened = false;
  let e = s;
  for (; e < lines.length && e < s + 400; e++) {
    for (const ch of lines[e].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "")) {
      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") depth--;
    }
    if (opened && depth <= 0) break;
  }
  const m = fnRx.exec(lines[s]);
  return { start: s + 1, end: Math.min(e + 1, s + 80), name: m?.slice(1).find(Boolean) ?? "" };
}

export function snippet(text: string, line: number, lang: RawSite["lang"]): string {
  const { start, end } = enclosing(text, line, lang);
  return text.split("\n").slice(start - 1, end).join("\n");
}

// ---------- marks (same keyword table as the python pass) ----------

const MARK_WORDS: Record<Mark, string[]> = {
  lock: ["pg_advisory", "pg_try_advisory", "advisory_lock", "advisory_xact_lock", "for update", "skip locked", "acquire_lock", ".lock("],
  conflict: ["on conflict"],
  dedup: ["already_processed", "idempoten", "processed_messages", "upstash-message-id"],
  version: ["generation !=", "generation ==", "generation <", "version !=", "version ==", "version <", "generation = %(", "version = %("],
  retried: ["upstash-retried"],
  nonretry: ["nonretryable", " 489"],
  sig: ["verify_qstash_sig", "receiver("],
  svc: ["require_service_role", "require_user_or_service"],
};
export function marksOf(src: string): Mark[] {
  const low = src.toLowerCase();
  return (Object.keys(MARK_WORDS) as Mark[]).filter((k) => MARK_WORDS[k].some((w) => low.includes(w)));
}

// ---------- TypeScript (frontend) ----------

const tsExpr = (raw: string, text: string): string => {
  raw = raw.trim().replace(/,$/, "");
  const lit = /^[`"']([\s\S]*)[`"']$/.exec(raw);
  if (lit) return lit[1].replace(/\$\{process\.env\.(\w+)\}/g, "{env:$1}").replace(/\$\{([^}]*)\}/g, (_, e: string) => `{${e.trim().split(/[.(\s]/).pop()}}`);
  if (/^\w+$/.test(raw)) {
    const def = new RegExp(String.raw`(?:const|let|var)\s+${raw}\s*(?::[^=]+)?=\s*([\`"'][^\n]*[\`"'])`).exec(text);
    if (def) return tsExpr(def[1], text);
  }
  return `{${raw.slice(0, 30)}}`;
};

function objectAt(text: string, from: number): string {
  let depth = 0;
  for (let i = from; i < text.length && i < from + 4000; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth < 0) return text.slice(from, i);
  }
  return text.slice(from, from + 1500);
}

const num = (s?: string) => (s && /^\d+$/.test(s) ? Number(s) : s);

export function tsSites(file: string, text: string): RawSite[] {
  if (!/@upstash\/qstash/.test(text) || !/\.(publishJSON|batchJSON|enqueueJSON|publish)\(/.test(text)) return [];
  const out: RawSite[] = [];
  const call = /\.(batchJSON|publishJSON|enqueueJSON)\(/.exec(text)?.[1] ?? "publishJSON";
  for (const m of text.matchAll(/\burl:\s*([^\n,}]+)/g)) {
    const at = m.index!;
    const obj = objectAt(text, at);
    const line = text.slice(0, at).split("\n").length;
    const fc = /flowControl:\s*\{([^}]*)\}/.exec(obj)?.[1] ?? "";
    const g = (rx: RegExp, s = obj) => rx.exec(s)?.[1];
    const kw: Kw = { url: tsExpr(m[1], text) };
    const r = g(/\bretries:\s*(\d+)/);
    if (r) kw.retries = Number(r);
    const d = g(/\bdelay:\s*([^,\n]+)/);
    if (d) kw.delay = tsExpr(d, text);
    const dd = g(/\bdeduplicationId:\s*([^,\n]+)/);
    if (dd) kw.deduplication_id = tsExpr(dd, text);
    if (/contentBasedDeduplication:\s*true/.test(obj)) kw.content_based_deduplication = true;
    const fcb = g(/\bfailureCallback:\s*([^,\n]+)/);
    if (fcb) kw.failure_callback = tsExpr(fcb, text);
    const to = g(/\btimeout:\s*([^,\n]+)/);
    if (to) kw.timeout = tsExpr(to, text);
    if (fc) {
      const key = g(/key:\s*([^,\n]+)/, fc);
      kw.flow_control = {
        key: key ? tsExpr(key, text) : "",
        parallelism: num(g(/parallelism:\s*(\d+)/, fc)),
        ratePerSecond: num(g(/ratePerSecond:\s*(\d+)/, fc)),
        rate: num(g(/\brate:\s*(\d+)/, fc)),
        period: g(/period:\s*["'`]([^"'`]+)/, fc),
      };
    }
    const fn = enclosing(text, line, "ts").name;
    out.push({ file, line, end: line + obj.split("\n").length, fn, lang: "ts", call: call === "batchJSON" ? "dict" : call, via: call === "batchJSON" ? "batch_json" : null, kw });
  }
  return out;
}

// Next.js route handler that verifies QStash with Receiver.
export function nextRoutes(file: string, text: string): RawRoute[] {
  const m = /(?:^|\/)src\/app(\/api\/.+)\/route\.tsx?$/.exec(file);
  if (!m || !/Receiver/.test(text)) return [];
  const route = m[1].replace(/\[([^\]]+)\]/g, "{$1}");
  const out: RawRoute[] = [];
  for (const h of text.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) {
    const line = text.slice(0, h.index).split("\n").length;
    out.push({ file, line, fn: h[1], method: h[1].toLowerCase(), path: route, auth: "receiver", marks: marksOf(text), reach: [] });
  }
  return out;
}

// ---------- Go lambdas ----------

export function goExtract(file: string, text: string): { sites: RawSite[]; lambdas: RawLambda[] } {
  const sites: RawSite[] = [];
  const lambdas: RawLambda[] = [];
  const lineAt = (i: number) => text.slice(0, i).split("\n").length;
  for (const m of text.matchAll(/\.SendMessage(Batch)?\(/g)) {
    const line = lineAt(m.index!);
    const q = /QueueUrl:\s*([\w.]+)/.exec(text.slice(m.index!, m.index! + 400))?.[1] ?? "";
    sites.push({ file, line, end: line, fn: enclosing(text, line, "go").name, lang: "go", call: m[1] ? "send_message_batch" : "send_message", kw: { QueueUrl: `{${q.split(".").pop()}}` } });
  }
  if (/qstash\.upstash\.io\/v2\/(batch|publish)/.test(text)) {
    for (const m of text.matchAll(/"(\/v\d\/[\w\-/{}]+)"/g)) {
      const line = lineAt(m.index!);
      const retries = /Upstash-Retries"?\s*[:,]\s*"?(\d+)/.exec(text)?.[1];
      sites.push({ file, line, end: line, fn: enclosing(text, line, "go").name, lang: "go", call: "dict", via: "batch_json", kw: { url: `{env:API_URL}${m[1]}`, ...(retries ? { retries: Number(retries) } : {}) } });
    }
  }
  const start = /lambda\.Start\(/.exec(text);
  if (start && /events\.SQSEvent/.test(text)) {
    lambdas.push({ file, line: lineAt(start.index), fn: "main", sqs: true, marks: marksOf(text), reach: [], lang: "go" });
  }
  return { sites, lambdas };
}

// ---------- regex fallback for python (no python3) ----------

const pyKw = (body: string): Kw => {
  const kw: Kw = {};
  for (const m of body.matchAll(/(\w+)\s*=\s*(f?"[^"\n]*"|f?'[^'\n]*'|-?\d+|True|False|\{[^}\n]*\}|[\w.[\]'"]+)/g)) {
    let v: unknown = m[2];
    const s = m[2];
    if (/^-?\d+$/.test(s)) v = Number(s);
    else if (s === "True" || s === "False") v = s === "True";
    else if (/^f?["']/.test(s)) v = s.replace(/^f?["']|["']$/g, "").replace(/\{os\.environ\[['"](\w+)['"]\][^}]*\}/g, "{env:$1}");
    else if (s.startsWith("{")) {
      const o: Record<string, unknown> = {};
      for (const p of s.matchAll(/["'](\w+)["']\s*:\s*(?:f?["']([^"']*)["']|(\d+))/g)) o[p[1]] = p[3] ? Number(p[3]) : p[2];
      v = o;
    } else v = `{${s}}`;
    if (!(m[1] in kw)) kw[m[1]] = v;
  }
  return kw;
};

function callBody(text: string, from: number): string {
  let depth = 0;
  for (let i = from; i < text.length && i < from + 5000; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(from, i + 1);
  }
  return text.slice(from, from + 800);
}

export function regexPy(hits: Hit[]): PyOut {
  const out: PyOut = { pubs: [], crons: [], routes: [], lambdas: [], envs: {}, parsed: 0 };
  for (const h of hits) {
    if (!h.file.endsWith(".py")) continue;
    out.parsed++;
    const t = h.text;
    const lineAt = (i: number) => t.slice(0, i).split("\n").length;
    for (const m of t.matchAll(/(?:\.(publish_json|batch_json|enqueue_json|create_json|send_message_batch|send_message)|\b(batch_enqueue))\(/g)) {
      const line = lineAt(m.index!);
      const kw = pyKw(callBody(t, m.index! + m[0].length - 1));
      const call = m[1] ?? m[2];
      if (call.startsWith("send_message") && !("QueueUrl" in kw)) continue;
      out.pubs.push({ file: h.file, line, end: line, fn: enclosing(t, line, "py").name, call, kw });
    }
    for (const m of t.matchAll(/CronJob\(/g)) out.crons.push({ file: h.file, line: lineAt(m.index!), kw: pyKw(callBody(t, m.index! + 7)) });
    for (const m of t.matchAll(/^def lambda_handler/gm)) {
      out.lambdas.push({ file: h.file, line: lineAt(m.index!), fn: "lambda_handler", sqs: /Records|batchItemFailures/.test(t), marks: marksOf(t), reach: [] });
    }
    const prefix = /APIRouter\(\s*prefix=["']([^"']+)/.exec(t)?.[1] ?? "";
    for (const m of t.matchAll(/@\w+\.(post|get|put|patch|delete)\(\s*["']([^"']+)["']([^\n]*)\n(?:@[^\n]*\n)*\s*(?:async\s+)?def\s+(\w+)/g)) {
      const auth = /verify_qstash_sig/.test(m[3]) ? "qstash-sig" : /require_service_role|Actor/.test(m[0]) ? "service-role" : "unknown";
      out.routes.push({ file: h.file, line: lineAt(m.index!), fn: m[4], method: m[1], path: prefix + m[2], auth, marks: [], reach: [] });
    }
  }
  return out;
}

// ---------- the whole deterministic pass ----------

export async function extract(repo: string, ignore: string[], overrides?: Record<string, string | null>): Promise<RawScan> {
  const all: string[] = [];
  const hits = hitFiles(repo, ignore, overrides, all);
  const py = await runPyScan(repo, ignore, overrides);
  const p = py ?? regexPy(hits);
  const sites: RawSite[] = p.pubs.map((x) => ({ ...x, lang: "py" as const }));
  const routes: RawRoute[] = [...p.routes];
  const lambdas: RawLambda[] = p.lambdas.map((l) => ({ ...l, lang: "py" as const }));
  const goSites = new Map<string, RawSite[]>();
  for (const h of hits) {
    if (/\.tsx?$/.test(h.file)) {
      sites.push(...tsSites(h.file, h.text));
      routes.push(...nextRoutes(h.file, h.text));
    } else if (h.file.endsWith(".go")) {
      const g = goExtract(h.file, h.text);
      sites.push(...g.sites);
      lambdas.push(...g.lambdas);
      const top = h.file.split("/")[0];
      goSites.set(top, [...(goSites.get(top) ?? []), ...g.sites]);
    }
  }
  // a go lambda reaches every go publish site in its module
  for (const l of lambdas) if (l.lang === "go") l.reach = (goSites.get(l.file.split("/")[0]) ?? []).map((s) => `${s.file}:${s.fn}`);
  const infra = infraFrom(hits, all);
  const depHit = hits.find((h) => h.file.endsWith("_dependencies.yaml"));
  const dep = depHit ? depsFrom(depHit.text) : { deps: [], queues: [] };
  const queues = [...infra.queues];
  for (const q of dep.queues) if (!queues.some((x) => x.name === q)) queues.push({ name: q, file: depHit!.file });
  return {
    sites, routes, crons: p.crons, lambdas, queues, esm: infra.esm, rules: infra.rules, gh: infra.gh, deps: dep.deps, queueEnv: infra.queueEnv,
    envs: p.envs, files: hits.map(({ file, sha, mtime, size }) => ({ file, sha, mtime, size })), engine: py ? "python" : "regex",
  };
}
