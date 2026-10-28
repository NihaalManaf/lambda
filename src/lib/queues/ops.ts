// QueueOp algebra: apply ops to a topology (with per-id diff states) and diff two topologies into ops. Pure.
import type { DiffState } from "../types";
import { cluster } from "./cluster";
import { chanLabel, humanize } from "./link";
import { queueRisks } from "./risk";
import type { Linked } from "./link";
import type { QEdge, QueueOp, Topology } from "./types";

const eid = (from: string, to: string, role: QEdge["role"]) => `${from}>${to}:${role}`;
const pre = (p: string, id: string) => (/^[pckd]:/.test(id) ? id : `${p}:${id}`);

export function toTopology(l: Linked, meta: { sig: string; files: number; scannedAt?: string }): Topology {
  return {
    producers: l.producers, channels: l.channels, consumers: l.consumers, edges: l.edges,
    domains: cluster(l), risks: queueRisks(l), sig: meta.sig, scannedAt: meta.scannedAt ?? new Date().toISOString(), files: meta.files, unresolved: l.unresolved,
  };
}

export interface Applied { topo: Topology; diff: Map<string, DiffState> }

export function applyQueueOps(base: Topology, ops: QueueOp[]): Applied {
  const t: Topology = structuredClone(base);
  const diff = new Map<string, DiffState>();
  const has = (id: string) => t.producers.some((x) => x.id === id) || t.channels.some((x) => x.id === id) || t.consumers.some((x) => x.id === id);
  for (const op of ops) {
    if (op.op === "add_producer") {
      const id = pre("p", op.id);
      if (has(id)) continue;
      t.producers.push({ id, label: humanize(op.label), file: "", line: 0, symbol: op.label, lang: "py", ...(op.trigger && { trigger: op.trigger }) });
      diff.set(id, "added");
    } else if (op.op === "add_channel") {
      const id = op.id.startsWith("c:") ? op.id : `c:${op.kind}:${op.key}`;
      if (has(id)) continue;
      t.channels.push({ id, kind: op.kind, key: op.key, label: chanLabel(op.kind, op.key), ...(op.cron && { cron: op.cron }) });
      diff.set(id, "added");
    } else if (op.op === "add_consumer") {
      const id = pre("k", op.id);
      if (has(id)) continue;
      t.consumers.push({ id, label: humanize(op.label), file: "", line: 0, symbol: op.label, ...(op.route && { route: op.route }), auth: op.auth, idempotency: op.idempotency, retryAware: false, nonRetryable: false });
      diff.set(id, "added");
    } else if (op.op === "add_edge") {
      if (!has(op.from) || !has(op.to)) continue;
      const id = eid(op.from, op.to, op.role);
      if (t.edges.some((e) => e.id === id)) continue;
      t.edges.push({ id, from: op.from, to: op.to, role: op.role, ...(op.opts && { opts: op.opts }) });
      diff.set(id, "added");
    } else if (op.op === "change_opts") {
      const e = t.edges.find((x) => x.id === op.edge);
      if (!e) continue;
      e.opts = { ...e.opts, ...op.opts };
      if (!diff.has(e.id)) diff.set(e.id, "changed");
      for (const n of [e.from, e.to]) if (!diff.has(n)) diff.set(n, "changed");
    } else if (op.op === "remove") {
      if (t.edges.some((e) => e.id === op.id)) diff.set(op.id, "removed");
      else if (has(op.id)) {
        diff.set(op.id, "removed");
        for (const e of t.edges) if (e.from === op.id || e.to === op.id) diff.set(e.id, "removed");
      }
    }
  }
  // removed things stay drawable (struck through) but no longer count for risks
  const live = (id: string) => diff.get(id) !== "removed";
  const alive = {
    producers: t.producers.filter((x) => live(x.id)), channels: t.channels.filter((x) => live(x.id)),
    consumers: t.consumers.filter((x) => live(x.id)), edges: t.edges.filter((x) => live(x.id)),
  };
  t.domains = cluster(t);
  t.risks = queueRisks(alive);
  return { topo: t, diff };
}

const sameOpts = (a: QEdge, b: QEdge) => JSON.stringify(a.opts ?? {}) === JSON.stringify(b.opts ?? {});

// before -> after as ops (git proposals)
export function diffTopologies(before: Topology, after: Topology): QueueOp[] {
  const ops: QueueOp[] = [];
  const ids = (t: Topology) => new Set([...t.producers, ...t.channels, ...t.consumers].map((x) => x.id));
  const bIds = ids(before);
  const aIds = ids(after);
  for (const p of after.producers) if (!bIds.has(p.id)) ops.push({ op: "add_producer", id: p.id, label: p.label, ...(p.trigger && { trigger: p.trigger }) });
  for (const c of after.channels) if (!bIds.has(c.id)) ops.push({ op: "add_channel", id: c.id, kind: c.kind, key: c.key, ...(c.cron && { cron: c.cron }) });
  for (const k of after.consumers)
    if (!bIds.has(k.id)) ops.push({ op: "add_consumer", id: k.id, label: k.label, ...(k.route && { route: k.route }), idempotency: k.idempotency, auth: k.auth });
  const bEdges = new Map(before.edges.map((e) => [e.id, e]));
  const aEdges = new Map(after.edges.map((e) => [e.id, e]));
  for (const e of after.edges) {
    const old = bEdges.get(e.id);
    if (!old) ops.push({ op: "add_edge", from: e.from, to: e.to, role: e.role, ...(e.opts && { opts: e.opts }) });
    else if (!sameOpts(old, e)) ops.push({ op: "change_opts", edge: e.id, opts: e.opts ?? {} });
  }
  for (const e of before.edges) if (!aEdges.has(e.id) && aIds.has(e.from) && aIds.has(e.to)) ops.push({ op: "remove", id: e.id });
  for (const id of bIds) if (!aIds.has(id)) ops.push({ op: "remove", id });
  return ops;
}

// ids an op set touches: what a proposal view centres on
export function touched(diff: Map<string, DiffState>, t: Topology): Set<string> {
  const out = new Set<string>();
  for (const id of diff.keys()) {
    const e = t.edges.find((x) => x.id === id);
    for (const n of e ? [e.from, e.to] : [id]) out.add(n);
  }
  return out;
}
