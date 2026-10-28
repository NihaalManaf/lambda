// Queue risk rules (spec §4.1). Labels <= 3 words, why <= 12 words. Pure.
import type { Risk, RiskLevel } from "../types";
import type { Channel, Consumer, QEdge } from "./types";
import type { Linked } from "./link";

const AT_LEAST_ONCE = new Set<Channel["kind"]>(["qstash-url", "qstash-queue", "qstash-schedule", "sqs"]);
const DB_POOL = 8;

// minutes between runs; only "*/n ..." and "* * * * *" are understood
export function cronEveryMin(cron?: string): number | null {
  if (!cron) return null;
  const f = cron.replace(/^CRON_TZ=\S+\s+/, "").trim().split(/\s+/);
  if (f.length < 5 || f.slice(2).some((x) => x !== "*")) return null;
  if (f[0] === "*" && f[1] === "*") return 1;
  const m = /^\*\/(\d+)$/.exec(f[0]);
  return m && f[1] === "*" ? Number(m[1]) : null;
}
export const seconds = (d?: string): number | null => {
  const m = d && /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(d.trim());
  if (!m) return null;
  return Number(m[1]) * ({ ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[(m[2] ?? "s") as "s"] ?? 1);
};

export function queueRisks(t: Pick<Linked, "producers" | "channels" | "consumers" | "edges">): Risk[] {
  const out: Risk[] = [];
  const add = (rule: string, level: RiskLevel, label: string, why: string, kind: "node" | "edge", id: string) =>
    out.push({ id: `${rule}:${id}`, rule, level, label, why, target: { kind, id } });
  const chans = new Map(t.channels.map((c) => [c.id, c]));
  const cons = new Map(t.consumers.map((k) => [k.id, k]));
  const delivers = (cid: string): Consumer[] => t.edges.filter((e) => e.from === cid && e.role === "deliver").map((e) => cons.get(e.to)).filter((k): k is Consumer => !!k);
  const sends = (e: QEdge) => e.role === "publish" || e.role === "schedule" || e.role === "loop";

  for (const e of t.edges.filter(sends)) {
    const o = e.opts ?? {};
    const c = chans.get(e.to);
    const r = o.retries;
    if (r !== undefined && r > 0) {
      for (const k of delivers(e.to)) if (k.idempotency === "none") add("retry-duplicates", "bad", "retry duplicates", `${r} retries into a handler with no idempotency guard`, "node", k.id);
      if (!o.failureCallback && !c?.dlq) add("no-dead-letter", "warn", "no dead letter", "retries run out and the message silently disappears", "edge", e.id);
    }
    if (r === 0 && !o.failureCallback && !o.callback) add("fire-and-forget", "info", "fire and forget", "no retry, no callback: one failure drops it", "edge", e.id);
    if ((o.fanout === "batch" || o.fanout === "loop") && !o.flow) add("unthrottled-fanout", "bad", "unthrottled fan-out", "batch fan-out without flow control can stampede the api", "edge", e.id);
    if ((o.flow?.parallelism ?? 0) > DB_POOL) add("exceeds-db-pool", "warn", "exceeds db pool", `parallelism ${o.flow!.parallelism} vs ${DB_POOL} db connections`, "edge", e.id);
    if (e.role === "loop" && (!o.dedup || o.dedup === "none" || o.dedup === "random") && !o.flow) add("runaway-loop", "warn", "runaway loop", "self re-publish without dedup or flow control", "edge", e.id);
    if (e.role === "schedule" && c) {
      const every = cronEveryMin(c.cron);
      const serial = o.flow?.key && o.flow.parallelism === 1;
      for (const k of delivers(c.id)) {
        const to = seconds(o.timeout ?? k.timeout);
        if (every != null && to != null && to > every * 60 && !serial) add("runs-overlap", "warn", "runs overlap", `runs every ${every}m but may take ${Math.round(to / 60)}m`, "node", c.id);
      }
    }
  }
  for (const k of t.consumers) {
    const atLeastOnce = t.edges.some((e) => e.to === k.id && e.role === "deliver" && AT_LEAST_ONCE.has(chans.get(e.from)?.kind ?? "pubsub"));
    if (atLeastOnce && (k.idempotency === "none" || k.idempotency === "unknown")) add("not-idempotent", "warn", "not idempotent", "redelivery can run this twice; no lock or dedup seen", "node", k.id);
    if (k.auth === "none") add("unauthenticated", "bad", "unauthenticated", "anyone who finds the url can enqueue work", "node", k.id);
    if (k.nonRetryable) add("poison-handled", "info", "poison handled", "bad messages stop retrying instead of looping", "node", k.id);
  }
  for (const c of t.channels) {
    if (/staging/i.test(c.host ?? "")) add("points-at-staging", "bad", "points at staging", `production traffic goes to ${c.host}`, "node", c.id);
    if (c.key.startsWith("?")) add("unknown-target", "info", "unknown target", "destination could not be resolved statically", "node", c.id);
    else if (c.kind !== "gh-cron" && !t.edges.some((e) => e.from === c.id && e.role === "deliver") && !/\./.test(c.key.split("/")[0]))
      add("no-consumer", "warn", "no consumer", "nothing in the repo handles this channel", "node", c.id);
  }
  return out;
}
