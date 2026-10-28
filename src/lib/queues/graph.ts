// Topology -> drawable QueueGraph. Overview = one card per domain; domain view capped at 14 nodes,
// split into parts by channel group, crowded siblings collapsed into "+N". Pure.
import type { Badge, DiffState, Risk } from "../types";
import type { MsgOptions, QEdge, QGEdge, QGNode, QueueGraph, Topology } from "./types";

export const MAX_QUEUE_NODES = 14;
const MAX_SIBLINGS = 4;
const words = (s: string, n = 4) => s.split(/\s+/).filter(Boolean).slice(0, n).join(" ");
const rank = { bad: 0, warn: 1, info: 2 } as const;

export function edgeBadges(o: MsgOptions = {}): Badge[] {
  const b: Badge[] = [];
  if (o.retries) b.push({ icon: "retry", text: `${o.retries}`, title: `${o.retries} retries${o.retryDelay ? ", custom backoff" : ""}` });
  if (o.delay) b.push({ icon: "delay", text: o.delay.slice(0, 6), title: `delayed ${o.delay}` });
  if (o.dedup && o.dedup !== "none") b.push({ icon: "dedup", tone: o.dedup === "random" ? "warn" : "ok", title: `${o.dedup} dedup id` });
  if (o.flow) b.push({ icon: "flow", text: o.flow.parallelism ? `${o.flow.parallelism}` : undefined, title: `flow ${o.flow.parallelism ?? "?"} at once` });
  if (o.failureCallback || o.callback) b.push({ icon: "callback", title: "failure callback" });
  if (o.timeout) b.push({ icon: "clock", text: o.timeout.slice(0, 6), title: `timeout ${o.timeout}` });
  return b;
}

const motion = (o: MsgOptions = {}) => {
  const par = o.flow?.parallelism;
  const rate = o.flow?.rate;
  return {
    dots: (par ? Math.min(3, Math.ceil(par / 10)) : 1) as QGEdge["dots"],
    speed: rate ? +(1.2 / Math.log2(2 + rate)).toFixed(2) : 2.5,
    retry: (o.retries ?? 0) > 0,
  };
};

export function nodeOf(t: Topology, id: string): QGNode | null {
  const p = t.producers.find((x) => x.id === id);
  if (p) {
    const trig = p.trigger;
    return {
      id, kind: trig && trig.kind !== "http" ? "trigger" : "producer",
      sub: trig?.kind === "cron" ? trig.cron : trig?.kind === "event" ? "event" : p.lang,
      label: words(p.label), diff: "same", badges: trig?.kind === "http" ? [{ icon: "globe", title: trig.route.slice(0, 40) }] : [], riskIds: [], ref: { file: p.file, line: p.line },
    };
  }
  const c = t.channels.find((x) => x.id === id);
  if (c) {
    const badges: Badge[] = [];
    if (c.dlq) badges.push({ icon: "shield", text: "dlq", tone: "ok", title: `dead letter ${c.dlq}` });
    if (/staging/i.test(c.host ?? "")) badges.push({ icon: "warn", text: "stg", tone: "bad", title: "points at staging" });
    if (c.cron) badges.push({ icon: "cron", title: c.cron });
    return { id, kind: "channel", sub: c.kind, label: words(c.label), diff: "same", badges, riskIds: [] };
  }
  const k = t.consumers.find((x) => x.id === id);
  if (k) {
    const badges: Badge[] = [];
    const tone = ({ "qstash-sig": "ok", receiver: "ok", "service-role": "muted", "sqs-lambda": "muted", none: "bad", unknown: undefined } as const)[k.auth];
    if (tone) badges.push({ icon: "shield", tone, title: k.auth === "none" ? "no auth" : `${k.auth} auth` });
    if (k.idempotency === "lock") badges.push({ icon: "lock", tone: "ok", title: "locked: safe to redeliver" });
    else if (k.idempotency === "none" || k.idempotency === "unknown") badges.push({ icon: "warn", tone: "warn", title: `idempotency ${k.idempotency}` });
    else badges.push({ icon: "dedup", tone: "ok", title: `idempotent via ${k.idempotency}` });
    if (k.nonRetryable) badges.push({ icon: "shield", text: "489", tone: "ok", title: "rejects poison messages" });
    else if (k.retryAware) badges.push({ icon: "retry", tone: "muted", title: "reads retry count" });
    return { id, kind: "consumer", sub: k.auth, label: words(k.label), diff: "same", badges, riskIds: [], ref: { file: k.file, line: k.line } };
  }
  return null;
}

const domainOfNode = (t: Topology) => {
  const m = new Map<string, string>();
  for (const d of t.domains) for (const n of d.nodeIds) m.set(n, d.id);
  return m;
};

function attachRisks(nodes: QGNode[], edges: QGEdge[], risks: Risk[]): Risk[] {
  const ids = new Set([...nodes.map((n) => n.id), ...edges.map((e) => e.id)]);
  const out = risks.filter((r) => ids.has(r.target.id)).sort((a, b) => rank[a.level] - rank[b.level]);
  const byNode = new Map(nodes.map((n) => [n.id, n]));
  for (const r of out) {
    const n = byNode.get(r.target.id) ?? byNode.get(edges.find((e) => e.id === r.target.id)?.from ?? "");
    if (n && r.level !== "info") n.riskIds.push(r.id);
  }
  return out;
}

// ---------- overview ----------

export function overview(t: Topology): QueueGraph {
  const dom = domainOfNode(t);
  const riskDom = (r: Risk) => dom.get(r.target.id) ?? dom.get(t.edges.find((e) => e.id === r.target.id)?.from ?? "");
  const nodes: QGNode[] = t.domains.map((d) => {
    const ids = new Set(d.nodeIds);
    const n = (pfx: string) => d.nodeIds.filter((x) => x.startsWith(pfx)).length;
    const rs = t.risks.filter((r) => riskDom(r) === d.id);
    const worst = rs.reduce<Risk["level"] | "">((w, r) => (!w || rank[r.level] < rank[w] ? r.level : w), "");
    return {
      id: `d:${d.id}`, kind: "domain", sub: worst, label: d.label, diff: "same", count: ids.size, riskIds: [],
      badges: [
        { icon: "flow", text: `${n("p:")}`, title: "producers" },
        { icon: "queue", text: `${n("c:")}`, title: "channels" },
        { icon: "bolt", text: `${n("k:")}`, title: "consumers" },
        ...(rs.some((r) => r.level === "bad") ? [{ icon: "warn" as const, text: `${rs.filter((r) => r.level === "bad").length}`, tone: "bad" as const, title: "serious risks" }] : []),
      ],
    };
  });
  const agg = new Map<string, { n: number; retry: boolean }>();
  for (const e of t.edges) {
    const a = dom.get(e.from);
    const b = dom.get(e.to);
    if (!a || !b || a === b) continue;
    const k = `d:${a}>d:${b}`;
    const v = agg.get(k) ?? { n: 0, retry: false };
    v.n++;
    v.retry ||= (e.opts?.retries ?? 0) > 0;
    agg.set(k, v);
  }
  const edges: QGEdge[] = [...agg].map(([k, v]) => {
    const [from, to] = k.split(">");
    return { id: k, from, to, role: "publish", diff: "same", dots: 0, speed: 2.5, retry: v.retry, badges: [{ icon: "flow", text: `${v.n}`, title: `${v.n} message paths` }] };
  });
  const risks = t.risks.filter((r) => r.level !== "info").sort((a, b) => rank[a.level] - rank[b.level]).slice(0, 80);
  for (const r of risks) {
    const d = riskDom(r);
    if (d) nodes.find((n) => n.id === `d:${d}`)?.riskIds.push(r.id);
  }
  return { title: "all", nodes, edges, risks };
}

// ---------- subgraph (domain view / proposal view) ----------

interface ViewOpts { title: string; part?: string; diff?: Map<string, DiffState>; fade?: Set<string>; foreign?: boolean }

export function subgraph(t: Topology, ids: Set<string>, o: ViewOpts): QueueGraph {
  const dom = domainOfNode(t);
  const label = new Map(t.domains.map((d) => [d.id, d.label]));
  const inView = (id: string) => ids.has(id);
  // edges inside the view; edges to outside nodes point at a domain stub
  const raw: QEdge[] = [];
  const stubs = new Set<string>();
  for (const e of t.edges) {
    const a = inView(e.from);
    const b = inView(e.to);
    if (a && b) raw.push(e);
    else if (o.foreign !== false && (a || b)) {
      const other = dom.get(a ? e.to : e.from);
      if (!other) continue;
      const sid = `d:${other}`;
      stubs.add(sid);
      raw.push({ ...e, id: `${e.id}~`, from: a ? e.from : sid, to: a ? sid : e.to });
    }
  }
  // collapse > MAX_SIBLINGS same-kind neighbours of one channel into "+N"
  const kindOf = (id: string) => (id.startsWith("d:") ? "domain" : id.startsWith("p:") ? "p" : id.startsWith("k:") ? "k" : "c");
  const hidden = new Set<string>();
  const extra: QGNode[] = [];
  const edgesOut: QEdge[] = [];
  for (const c of [...ids].filter((x) => x.startsWith("c:"))) {
    for (const side of ["in", "out"] as const) {
      const es = raw.filter((e) => (side === "in" ? e.to === c : e.from === c));
      const groups = new Map<string, QEdge[]>();
      for (const e of es) {
        const nb = side === "in" ? e.from : e.to;
        if (o.diff?.has(nb)) continue; // never hide what a proposal changes
        groups.set(kindOf(nb), [...(groups.get(kindOf(nb)) ?? []), e]);
      }
      for (const [k, g] of groups) {
        if (g.length <= MAX_SIBLINGS || k === "domain") continue;
        const rest = g.slice(MAX_SIBLINGS - 1);
        const mid = `m:${c}:${side}:${k}`;
        for (const e of rest) {
          const nb = side === "in" ? e.from : e.to;
          if (!raw.some((x) => x !== e && !rest.includes(x) && (x.from === nb || x.to === nb))) hidden.add(nb);
        }
        extra.push({ id: mid, kind: "more", sub: k, label: `+${rest.length}`, diff: "same", badges: [], riskIds: [], count: rest.length });
        edgesOut.push({ id: `${mid}>e`, from: side === "in" ? mid : c, to: side === "in" ? c : mid, role: side === "in" ? rest[0].role : "deliver" });
        for (const e of rest) raw.splice(raw.indexOf(e), 1);
      }
    }
  }
  raw.push(...edgesOut);
  let nodes: QGNode[] = [
    ...[...ids].filter((id) => !hidden.has(id)).map((id) => nodeOf(t, id)).filter((n): n is QGNode => !!n),
    ...[...stubs].map((sid): QGNode => ({ id: sid, kind: "domain", sub: "", label: label.get(sid.slice(2)) ?? sid.slice(2), diff: "context", badges: [], riskIds: [] })),
    ...extra,
  ];
  for (const n of nodes) {
    const d = o.diff?.get(n.id);
    if (d) n.diff = d;
    else if (o.fade?.has(n.id)) n.diff = "context";
  }
  let edges = raw.filter((e) => nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to));

  // parts when over the cap: whole chains (trigger -> schedule -> handler -> channel -> worker) packed together;
  // a chain that alone is too big is split per channel group
  let parts: QueueGraph["parts"];
  if (nodes.length > MAX_QUEUE_NODES) {
    const local = new Set(nodes.filter((n) => n.kind !== "domain").map((n) => n.id));
    const root = new Map([...local].map((x) => [x, x]));
    const find = (x: string): string => (root.get(x) === x ? x : (root.set(x, find(root.get(x)!)), root.get(x)!));
    for (const e of edges) if (local.has(e.from) && local.has(e.to)) root.set(find(e.from), find(e.to));
    const comps = new Map<string, string[]>();
    for (const x of local) comps.set(find(x), [...(comps.get(find(x)) ?? []), x]);
    const units: Set<string>[] = [];
    for (const comp of comps.values()) {
      if (comp.length <= MAX_QUEUE_NODES) {
        units.push(new Set(comp));
        continue;
      }
      const inComp = new Set(comp);
      for (const c of comp.filter((x) => x.startsWith("c:"))) {
        const g = new Set([c]);
        for (const e of edges) {
          if (e.to === c && inComp.has(e.from)) g.add(e.from);
          if (e.from === c && inComp.has(e.to)) g.add(e.to);
        }
        units.push(g);
      }
    }
    const bad = new Set(t.risks.filter((r) => r.level === "bad").map((r) => r.target.id));
    const weight = (u: Set<string>) => [...u].some((x) => bad.has(x)) ? 100 + u.size : u.size;
    units.sort((a, b) => weight(b) - weight(a));
    const packed: Set<string>[] = [];
    for (const u of units) {
      const fit = packed.find((p) => new Set([...p, ...u]).size <= MAX_QUEUE_NODES);
      if (fit) for (const x of u) fit.add(x);
      else packed.push(new Set(u));
    }
    // foreign-domain stubs ride along while there is room
    for (const p of packed)
      for (const e of edges) {
        const stub = p.has(e.from) && e.to.startsWith("d:") ? e.to : p.has(e.to) && e.from.startsWith("d:") ? e.from : null;
        if (stub && p.size < MAX_QUEUE_NODES) p.add(stub);
      }
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const title = (p: Set<string>) => {
      const deg = (id: string) => edges.filter((e) => e.from === id || e.to === id).length;
      const ch = [...p].filter((x) => byId.get(x)?.kind === "channel").sort((a, b) => Number(a.startsWith("c:qstash-schedule")) - Number(b.startsWith("c:qstash-schedule")) || deg(b) - deg(a));
      return byId.get(ch[0] ?? [...p][0])?.label ?? "part";
    };
    parts = packed.map((p, i) => ({ id: `p${i}`, label: words(title(p)) }));
    const pick = packed[Math.max(0, parts.findIndex((p) => p.id === o.part))] ?? packed[0];
    if (pick) {
      nodes = nodes.filter((n) => pick.has(n.id));
      edges = edges.filter((e) => pick.has(e.from) && pick.has(e.to));
    }
  }
  // deliver edges animate like the publish into their channel
  const inbound = new Map<string, MsgOptions>();
  for (const e of edges) if (e.opts && e.role !== "deliver") inbound.set(e.to, { ...inbound.get(e.to), ...e.opts });
  const qedges: QGEdge[] = edges.map((e) => {
    const opts = e.role === "deliver" ? inbound.get(e.from) : e.opts;
    const d = o.diff?.get(e.id) ?? (o.diff?.get(e.from) === "added" || o.diff?.get(e.to) === "added" ? "added" : o.fade?.has(e.from) && o.fade?.has(e.to) ? "context" : "same");
    return { id: e.id, from: e.from, to: e.to, role: e.role, diff: d, badges: e.role === "deliver" ? [] : edgeBadges(e.opts), ...motion(opts) };
  });
  const risks = attachRisks(nodes, qedges, t.risks);
  return { title: o.title, nodes, edges: qedges, risks, ...(parts && parts.length > 1 && { parts }) };
}

export function domainGraph(t: Topology, domainId: string, part?: string): QueueGraph | null {
  const d = t.domains.find((x) => x.id === domainId);
  if (!d) return null;
  return subgraph(t, new Set(d.nodeIds), { title: d.label, part });
}
