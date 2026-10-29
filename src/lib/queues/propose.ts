import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { blanksToNull, featurePrompt, generate, type Nulls } from "../llm";
import { getSettings, id, now } from "../store";
import type { FeatureView } from "../types";
import { ensureTopology, buildTopology } from "./cache";
import { subgraph } from "./graph";
import { applyQueueOps, diffTopologies, touched } from "./ops";
import { cachedNorm } from "./normalize";
import { EXTS, extract } from "./scan";
import type { ChannelKind, QueueGraph, QueueOp, QueueProposal, Topology } from "./types";

export { applyQueueOps };

// Proposals: what a feature would do to the queue topology, as ops (the model never writes code).

const run = promisify(execFile);
const KINDS = ["qstash-url", "qstash-queue", "qstash-schedule", "sqs", "pg-cron", "eventbridge", "gh-cron", "pubsub"] as const;
const ROLES = ["publish", "deliver", "schedule", "callback", "loop"] as const;
const IDEM = ["lock", "on-conflict", "dedup-check", "version", "none", "unknown"] as const;
const AUTH = ["qstash-sig", "service-role", "receiver", "sqs-lambda", "none", "unknown"] as const;

// flat op shape. "" = unset (structured output caps nullable params at 16); blanksToNull maps it back to null
const Op = z.object({
  op: z.enum(["add_producer", "add_channel", "add_consumer", "add_edge", "change_opts", "remove"]),
  id: z.string().describe("new ids: p:<name> producer, c:<kind>:<key> channel, k:<name> consumer; remove: any existing node or edge id"),
  label: z.string().describe("<= 4 words"),
  cron: z.string().describe("5-field cron for scheduled producers/channels"),
  kind: z.enum(["", ...KINDS]),
  key: z.string().describe("channel: route path, queue name or schedule id"),
  route: z.string(),
  idempotency: z.enum(["", ...IDEM]),
  auth: z.enum(["", ...AUTH]),
  from: z.string(),
  to: z.string(),
  role: z.enum(["", ...ROLES]),
  edge: z.string().describe("change_opts: existing edge id"),
  retries: z.number().nullable(),
  delay: z.string(),
  dedup: z.enum(["", "deterministic", "content", "random", "none"]),
  flowKey: z.string(),
  parallelism: z.number().nullable(),
  rate: z.number().nullable(),
  period: z.string(),
  failureCallback: z.string().describe("node id"),
  timeout: z.string(),
});
export const Out = z.object({ title: z.string().describe("<= 4 words"), ops: z.array(Op) });

const SYSTEM = `
you plan queue changes for a feature as a tiny list of ops on an existing queue map. no code, no prose.
- reuse existing ids when touching existing nodes. new ids: p:<snake_name>, k:<snake_name>, c:<kind>:<key>.
- producer -publish-> channel -deliver-> consumer. crons: producer with cron -schedule-> qstash-schedule channel.
- set message options deliberately: retries, dedup id, flow key + parallelism (db pool is 8), failure callback.
- leave unused fields "" (numbers null). consumers must say how they stay idempotent. 2-10 ops. labels <= 4 words. title <= 4 words.
`.trim();

const words = (s: string, n = 4) => s.trim().split(/\s+/).slice(0, n).join(" ");

function toOps(raw: z.infer<typeof Out>["ops"]): QueueOp[] {
  const out: QueueOp[] = [];
  for (const o of raw.map((r) => blanksToNull(r) as Nulls<typeof r>)) {
    const opts = {
      ...(o.retries != null && { retries: o.retries }), ...(o.delay && { delay: o.delay }), ...(o.dedup && { dedup: o.dedup }),
      ...(o.flowKey && { flow: { key: o.flowKey, ...(o.parallelism != null && { parallelism: o.parallelism }), ...(o.rate != null && { rate: o.rate }), ...(o.period && { period: o.period }) } }),
      ...(o.failureCallback && { failureCallback: o.failureCallback }), ...(o.timeout && { timeout: o.timeout }),
    };
    if (o.op === "add_producer" && o.id) out.push({ op: o.op, id: o.id, label: words(o.label ?? o.id), ...(o.cron && { trigger: { kind: "cron", cron: o.cron, scheduleId: o.id.replace(/^p:/, "") } }) });
    else if (o.op === "add_channel" && o.kind && o.key) out.push({ op: o.op, id: o.id ?? `c:${o.kind}:${o.key}`, kind: o.kind as ChannelKind, key: o.key, ...(o.cron && { cron: o.cron }) });
    else if (o.op === "add_consumer" && o.id) out.push({ op: o.op, id: o.id, label: words(o.label ?? o.id), ...(o.route && { route: o.route }), idempotency: o.idempotency || "unknown", auth: o.auth || "unknown" });
    else if (o.op === "add_edge" && o.from && o.to && o.role) out.push({ op: o.op, from: o.from, to: o.to, role: o.role, ...(Object.keys(opts).length && { opts }) });
    else if (o.op === "change_opts" && o.edge) out.push({ op: o.op, edge: o.edge, opts });
    else if (o.op === "remove" && o.id) out.push({ op: o.op, id: o.id });
  }
  return out;
}

// compact map lines for the domains the feature talks about (<= 2 domains, <= 160 lines)
function context(t: Topology, text: string): string {
  const toks = new Set(text.toLowerCase().match(/[a-z]{3,}/g) ?? []);
  const label = (nid: string) => [...t.producers, ...t.channels, ...t.consumers].find((n) => n.id === nid);
  const score = (d: Topology["domains"][number]) =>
    (toks.has(d.id) || toks.has(d.label) ? 10 : 0) + d.nodeIds.reduce((s, n) => s + ((label(n)?.label ?? "").split(" ").some((w) => toks.has(w)) ? 1 : 0), 0);
  const doms = [...t.domains].sort((a, b) => score(b) - score(a)).slice(0, 2);
  const ids = new Set(doms.flatMap((d) => d.nodeIds));
  const lines = [`domains: ${t.domains.map((d) => d.id).join(", ")}`];
  for (const p of t.producers) if (ids.has(p.id)) lines.push(`${p.id} "${p.label}"${p.trigger?.kind === "cron" ? ` cron ${p.trigger.cron}` : ""}`);
  for (const c of t.channels) if (ids.has(c.id)) lines.push(`${c.id}${c.dlq ? " dlq" : ""}`);
  for (const k of t.consumers) if (ids.has(k.id)) lines.push(`${k.id} "${k.label}" ${k.route ?? ""} idem=${k.idempotency} auth=${k.auth}`);
  for (const e of t.edges) if (ids.has(e.from) && ids.has(e.to)) {
    const o = e.opts ?? {};
    lines.push(`${e.id}${o.retries != null ? ` r=${o.retries}` : ""}${o.flow ? ` flow=${o.flow.key}/${o.flow.parallelism ?? "?"}` : ""}${o.dedup ? ` dedup=${o.dedup}` : ""}`);
  }
  return lines.slice(0, 160).join("\n");
}

export async function proposeFromPrompt(feature: FeatureView, text: string): Promise<QueueProposal> {
  const { topo } = await ensureTopology();
  const out = await generate({
    schema: Out, system: SYSTEM, effort: "medium", maxTokens: 4000,
    prompt: `${featurePrompt(feature)}\n\nqueue change wanted:\n${text}\n\nexisting queue map:\n${context(topo, `${feature.title} ${feature.brief} ${text}`)}`,
  });
  const ops = toOps(out.ops);
  if (!ops.length) throw new Error("model returned no usable ops");
  return { id: id("qp"), source: "llm", title: words(out.title) || "queue change", prompt: text, ops, baseSig: topo.sig, createdAt: now() };
}

async function changedFiles(repo: string): Promise<string[]> {
  const { stdout } = await run("git", ["-C", repo, "status", "--porcelain", "--untracked-files=all"], { maxBuffer: 8 << 20 });
  return stdout
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3).trim().split(" -> ").pop()!.replace(/^"(.*)"$/, "$1"))
    .filter((f) => EXTS.some((x) => f.endsWith(x)));
}

// the topology with HEAD contents swapped in for the given files
async function headTopology(files: string[]): Promise<Topology> {
  const { raw } = await ensureTopology();
  const { repoPath, queueIgnore } = getSettings();
  const overrides: Record<string, string | null> = {};
  for (const f of files) {
    try {
      overrides[f] = (await run("git", ["-C", repoPath, "show", `HEAD:${f}`], { maxBuffer: 16 << 20 })).stdout;
    } catch {
      overrides[f] = null; // new file: absent at HEAD
    }
  }
  return buildTopology(await extract(repoPath, queueIgnore ?? [], overrides), cachedNorm(raw));
}

// working tree vs HEAD for changed source files: re-extract with HEAD swapped in, diff the two topologies
export async function proposeFromGit(): Promise<QueueProposal> {
  const { topo } = await ensureTopology();
  const files = await changedFiles(getSettings().repoPath);
  if (!files.length) throw new Error("no changed source files");
  const ops = diffTopologies(await headTopology(files), topo);
  if (!ops.length) throw new Error("repo changes do not touch queues");
  return { id: id("qp"), source: "git", title: `${files.length} changed files`, ops, files, baseSig: topo.sig, createdAt: now() };
}

const heads = new Map<string, { sig: string; topo: Topology }>(); // pid -> HEAD topology at sig (git proposals replay on HEAD)

// proposal -> graph of touched nodes + 1-hop context, diff-coloured
export async function proposalGraph(p: QueueProposal): Promise<QueueGraph & { stale: boolean }> {
  const { topo } = await ensureTopology();
  let base = topo;
  if (p.source === "git" && p.files?.length) {
    let h = heads.get(p.id);
    if (h?.sig !== topo.sig) {
      h = { sig: topo.sig, topo: await headTopology(p.files) };
      heads.delete(p.id);
      heads.set(p.id, h);
      if (heads.size > 32) heads.delete(heads.keys().next().value!);
    }
    base = h.topo;
  }
  const { topo: next, diff } = applyQueueOps(base, p.ops);
  const core = touched(diff, next);
  const ctx = new Set<string>();
  for (const e of next.edges) {
    if (core.has(e.from)) ctx.add(e.to);
    if (core.has(e.to)) ctx.add(e.from);
  }
  for (const c of core) ctx.delete(c);
  const g = subgraph(next, new Set([...core, ...ctx]), { title: p.title, diff, fade: ctx, foreign: false });
  return { ...g, stale: p.baseSig !== topo.sig };
}
