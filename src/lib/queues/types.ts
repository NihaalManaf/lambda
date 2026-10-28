// Queue topology + views. Pure types: no server-only, shared with the client.
import type { Badge, DiffState, Risk } from "../types";

export type ChannelKind = "qstash-url" | "qstash-queue" | "qstash-schedule" | "sqs" | "pg-cron" | "eventbridge" | "gh-cron" | "pubsub";
export interface MsgOptions {
  retries?: number; retryDelay?: string; delay?: string; notBefore?: boolean;
  dedup?: "deterministic" | "content" | "random" | "none"; dedupExpr?: string;
  flow?: { key: string; parallelism?: number; rate?: number; period?: string };
  failureCallback?: string /* channel id */; callback?: string; timeout?: string; fanout?: "single" | "batch" | "loop"; label?: string; redact?: boolean;
}
export interface Producer {
  id: string; label: string; file: string; line: number; symbol: string; lang: "py" | "ts" | "go";
  trigger?: { kind: "cron"; cron: string; scheduleId: string } | { kind: "http"; route: string } | { kind: "event"; source: string };
}
export interface Channel { id: string; kind: ChannelKind; key: string /* path | queue | schedule id */; label: string; cron?: string; host?: string; dlq?: string }
export interface Consumer {
  id: string; label: string; file: string; line: number; symbol: string; route?: string;
  auth: "qstash-sig" | "service-role" | "receiver" | "sqs-lambda" | "none" | "unknown";
  idempotency: "lock" | "on-conflict" | "dedup-check" | "version" | "none" | "unknown"; retryAware: boolean; nonRetryable: boolean; timeout?: string;
}
export interface QEdge { id: string; from: string; to: string; role: "publish" | "deliver" | "schedule" | "callback" | "loop"; opts?: MsgOptions }
export interface Domain { id: string; label: string; nodeIds: string[] }
export interface Topology {
  producers: Producer[]; channels: Channel[]; consumers: Consumer[]; edges: QEdge[]; domains: Domain[]; risks: Risk[];
  sig: string; scannedAt: string; files: number; unresolved: number;
}

export interface QGNode {
  id: string; kind: "trigger" | "producer" | "channel" | "consumer" | "domain" | "more"; sub: string /* ChannelKind | lang | cron | auth */;
  label: string; diff: DiffState; badges: Badge[]; riskIds: string[]; ref?: { file: string; line: number }; count?: number;
}
export interface QGEdge {
  id: string; from: string; to: string; role: QEdge["role"]; badges: Badge[] /* max 3 shown */; diff: DiffState;
  dots: 0 | 1 | 2 | 3 /* from parallelism */; speed: number /* s per traversal, from rate */; retry: boolean;
}
export interface QueueGraph { title: string; nodes: QGNode[]; edges: QGEdge[]; risks: Risk[]; parts?: { id: string; label: string }[] }
export interface ScanStatus { state: "idle" | "scanning" | "normalizing" | "done" | "error"; done: number; total: number; error?: string }

export type QueueOp =
  | { op: "add_producer"; id: string; label: string; trigger?: Producer["trigger"] }
  | { op: "add_channel"; id: string; kind: ChannelKind; key: string; cron?: string }
  | { op: "add_consumer"; id: string; label: string; route?: string; idempotency: Consumer["idempotency"]; auth: Consumer["auth"] }
  | { op: "add_edge"; from: string; to: string; role: QEdge["role"]; opts?: MsgOptions }
  | { op: "change_opts"; edge: string; opts: MsgOptions }
  | { op: "remove"; id: string }; // node or edge; ids may reference existing topology ids
export interface QueueProposal { id: string; source: "llm" | "git"; title: string; prompt?: string; ops: QueueOp[]; files?: string[]; baseSig: string; createdAt: string }

// ---------- raw extraction (server side; deterministic pass output) ----------

export type Mark = "lock" | "conflict" | "dedup" | "version" | "retried" | "nonretry" | "sig" | "svc";
export type Kw = Record<string, unknown>;
export interface RawSite { file: string; line: number; end: number; fn: string; lang: Producer["lang"]; call: string; kw: Kw; sink?: boolean; via?: string | null; wrapper?: boolean }
export interface RawRoute { file: string; line: number; fn: string; method: string; path: string; auth: Consumer["auth"]; marks: Mark[]; reach: string[] }
export interface RawCron { file: string; line: number; kw: Kw; marks?: Mark[]; reach?: string[]; hline?: number }
export interface RawLambda { file: string; line: number; fn: string; sqs: boolean; marks: Mark[]; reach: string[]; lang: Producer["lang"] }
export interface RawQueue { name: string; dlq?: string; file?: string; line?: number }
export interface RawEsm { queue: string; file: string; fn: string }
export interface RawRule { id: string; cron: string; file: string; line: number; target?: { file: string; fn: string } }
export interface RawGhCron { id: string; cron: string; file: string; line: number }
export interface RawScan {
  sites: RawSite[]; routes: RawRoute[]; crons: RawCron[]; lambdas: RawLambda[];
  queues: RawQueue[]; esm: RawEsm[]; rules: RawRule[]; gh: RawGhCron[];
  deps: { caller: string; queue: string }[]; // caller = repo top dir
  queueEnv: { dir: string; env: string; queue: string }[]; // infra env var -> queue, scoped to a dir
  envs: Record<string, string[]>; // file -> SQS/QUEUE env names it reads
  files: { file: string; sha: string; mtime: number; size: number }[]; // files with hits
  engine: "python" | "regex";
  v?: number; // extractor version: a mismatch makes the cache stale
}
// LLM fill-ins per file, keyed by symbol:line. Deterministic values always win.
export interface NormFile {
  publishes: { symbol: string; line: number; channelKey: string | null; opts: MsgOptions }[];
  consumers: { symbol: string; line: number; route: string | null; idempotency: Consumer["idempotency"]; retryAware: boolean; nonRetryable: boolean }[];
}
