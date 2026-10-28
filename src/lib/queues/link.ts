// Raw extraction -> topology nodes + edges. Pure: no fs, no server-only.
// producer -publish-> channel -deliver-> consumer; a consumer that publishes is itself a source,
// a consumer re-publishing its own channel is a loop, failure_callback is a callback edge.
import { matchQueue, resolveUrl, sameName, type Target } from "./resolve";
import { RouteIndex } from "./routes";
import type {
  Channel, ChannelKind, Consumer, Kw, Mark, MsgOptions, NormFile, Producer, QEdge, RawLambda, RawRoute, RawScan, RawSite,
} from "./types";

export interface Linked { producers: Producer[]; channels: Channel[]; consumers: Consumer[]; edges: QEdge[]; unresolved: number }

const words = (s: string, n = 4) =>
  s.replace(/^_+/, "").replace(/([a-z])([A-Z])/g, "$1 $2").split(/[\s_\-.]+/).filter(Boolean).slice(0, n).join(" ").toLowerCase();
export const humanize = (s: string) => words(s) || s;
const GENERIC_FN = new Set(["handler", "main", "lambda_handler", "run", "process", "worker", "post", "get"]);
// "handler" in api/cron/jobs/sync_x.py reads as "sync x"
const nameOf = (fn: string, file: string) => humanize(GENERIC_FN.has(inner(fn).toLowerCase()) ? file.split("/").pop()!.replace(/\.\w+$/, "") : inner(fn));

const inner = (fn: string) => fn.split(".").pop() || fn;
const top = (file: string) => file.split("/")[0];
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
// durations computed at runtime render as "?" rather than leaking an expression into a badge
const dur = (v: unknown) => (typeof v === "number" ? `${v}s` : typeof v === "string" && v ? (v.includes("{") ? "?" : v.slice(0, 24)) : undefined);

export function idempotency(marks: Mark[] = []): Consumer["idempotency"] {
  return marks.includes("lock") ? "lock" : marks.includes("conflict") ? "on-conflict" : marks.includes("dedup") ? "dedup-check" : marks.includes("version") ? "version" : "unknown";
}

export function optsOf(call: string, kw: Kw, via?: string | null): MsgOptions {
  const o: MsgOptions = {};
  const retries = num(kw.retries) ?? (call === "batch_enqueue" || call === "CronJob" ? 0 : undefined);
  if (retries !== undefined) o.retries = retries;
  const rd = str(kw.retry_delay);
  if (rd) o.retryDelay = rd.slice(0, 40);
  const delay = dur(kw.delay);
  if (delay) o.delay = delay;
  if (kw.not_before != null) o.notBefore = true;
  const dd = str(kw.deduplication_id);
  if (kw.content_based_deduplication === true) o.dedup = "content";
  else if (dd) {
    o.dedup = /uuid4|uuid1|random|token_hex|nanoid|\{time|now\}/i.test(dd) ? "random" : "deterministic";
    o.dedupExpr = dd.slice(0, 60);
  }
  const fc = kw.flow_control && typeof kw.flow_control === "object" ? (kw.flow_control as Kw) : null;
  const key = str(fc?.key) ?? str(kw.flow_control_key);
  if (key) {
    const rps = num(fc?.ratePerSecond);
    const par = num(fc?.parallelism) ?? num(kw.flow_control_parallelism);
    const rate = num(fc?.rate) ?? num(kw.flow_control_rate) ?? rps;
    const period = str(fc?.period) ?? str(kw.flow_control_period) ?? (rps !== undefined ? "1s" : undefined);
    o.flow = { key: key.slice(0, 60), ...(par !== undefined && { parallelism: par }), ...(rate !== undefined && { rate }), ...(period && { period }) };
  }
  const fcb = str(kw.failure_callback);
  if (fcb) o.failureCallback = fcb;
  const cb = str(kw.callback);
  if (cb) o.callback = cb;
  const timeout = dur(kw.timeout) ?? (num(kw.timeout_ms) !== undefined ? `${Math.round(num(kw.timeout_ms)! / 1000)}s` : dur(kw.timeout_seconds));
  if (timeout) o.timeout = timeout;
  o.fanout = ["batch_json", "batch_enqueue"].includes(call) || ["batch_json", "batch_enqueue"].includes(via ?? "") ? "batch" : "single";
  const label = str(kw.label);
  if (label && !label.startsWith("{")) o.label = label.slice(0, 40);
  if (kw.redact) o.redact = true;
  return o;
}

// "*/5 * * * *" -> "every 5m", "0 1 * * *" -> "daily 1am"; anything odd -> "custom cron"
export function cronHuman(cron?: string): string {
  const f = (cron ?? "").replace(/^CRON_TZ=\S+\s+/, "").trim().split(/\s+/);
  if (f.length < 5) return "schedule";
  const [mi, h, dom, mon, dow] = f;
  const hr = (x: string) => (/^\d+$/.test(x) ? `${+x % 12 || 12}${+x < 12 ? "am" : "pm"}` : x);
  if (dom !== "*" || mon !== "*") return dom !== "*" && mon === "*" && dow === "*" && /^\d+$/.test(dom) ? "monthly" : "custom cron";
  if (mi === "*" && h === "*") return "every minute";
  if (/^\*\/\d+$/.test(mi) && h === "*") return `every ${mi.slice(2)}m`;
  if (/^\d+$/.test(mi) && h === "*") return "hourly";
  if (/^\d+$/.test(mi) && /^\*\/\d+$/.test(h)) return `every ${h.slice(2)}h`;
  if (/^\d+$/.test(mi) && /^\d+$/.test(h)) return dow === "*" ? `daily ${hr(h)}` : `weekly ${hr(h)}`;
  if (/^\d+$/.test(mi) && /^[\d,]+$/.test(h)) return `${h.split(",").length}x daily`;
  return "custom cron";
}

export const chanLabel = (kind: ChannelKind, key: string) =>
  key.startsWith("?") ? "unknown target" : kind === "qstash-url" ? key.split("/").filter(Boolean).slice(-2).join("/") || key : key;

export function link(raw: RawScan, norm: Record<string, NormFile> = {}): Linked {
  // cron handlers are routes too: /v1/internal/crons/{schedule_id}, signature-checked
  const cronRoutes: RawRoute[] = raw.crons.flatMap((c) => {
    const id = str(c.kw.schedule_id);
    const h = str(c.kw.handler);
    if (!id || !h) return [];
    const reach = c.reach ?? raw.sites.filter((s) => s.file === c.file && inner(s.fn) === h).map((s) => `${s.file}:${inner(s.fn)}`);
    return [{ file: c.file, line: c.hline ?? c.line, fn: h, method: "post", path: `/v1/internal/crons/${id}`, auth: "qstash-sig" as const, marks: c.marks ?? [], reach }];
  });
  const idx = new RouteIndex([...raw.routes, ...cronRoutes]);
  const producers = new Map<string, Producer>();
  const channels = new Map<string, Channel>();
  const consumers = new Map<string, Consumer>();
  const edges = new Map<string, QEdge>();
  const reachOf = new Map<string, string[]>(); // node id -> producer fn keys it reaches
  const delivered = new Map<string, Set<string>>(); // consumer id -> channels delivering to it
  const knownQueues = raw.queues.map((q) => q.name);
  let unresolved = 0;

  const addEdge = (e: Omit<QEdge, "id">) => {
    const id = `${e.from}>${e.to}:${e.role}`;
    if (!edges.has(id)) edges.set(id, { id, ...e });
    if (e.role === "deliver") delivered.set(e.to, (delivered.get(e.to) ?? new Set()).add(e.from));
    return id;
  };
  const chan = (kind: ChannelKind, key: string, extra: Partial<Channel> = {}) => {
    const id = `c:${kind}:${key}`;
    const c = channels.get(id) ?? { id, kind, key, label: chanLabel(kind, key) };
    if (extra.host && (!c.host || /staging/i.test(extra.host))) c.host = extra.host;
    if (extra.cron) {
      c.cron = extra.cron;
      if (kind !== "qstash-url" && kind !== "qstash-queue" && kind !== "sqs") c.label = cronHuman(extra.cron);
    }
    if (extra.dlq) c.dlq = extra.dlq;
    channels.set(id, c);
    return c;
  };
  const normCons = (file: string, fn: string) => norm[file]?.consumers.find((c) => c.symbol === fn || c.symbol.endsWith(`.${fn}`));
  const consumerOf = (o: { file: string; line: number; fn: string; label?: string; route?: string; auth: Consumer["auth"]; marks?: Mark[]; timeout?: string }, reach: string[] = []) => {
    const id = `k:${o.file}:${o.fn}`;
    if (!consumers.has(id)) {
      const n = normCons(o.file, o.fn);
      const marks = o.marks ?? [];
      const idem = idempotency(marks);
      consumers.set(id, {
        id, label: o.label ? humanize(o.label) : nameOf(o.fn, o.file), file: o.file, line: o.line, symbol: o.fn, ...(o.route && { route: o.route }), auth: o.auth,
        idempotency: idem === "unknown" && n ? n.idempotency : idem,
        retryAware: marks.includes("retried") || !!n?.retryAware, nonRetryable: marks.includes("nonretry") || !!n?.nonRetryable,
        ...(o.timeout && { timeout: o.timeout }),
      });
      reachOf.set(id, reach);
    }
    return consumers.get(id)!;
  };
  const routeConsumer = (r: RawRoute) => consumerOf({ file: r.file, line: r.line, fn: r.fn, route: r.path, auth: r.auth, marks: r.marks }, r.reach);
  const lambdaConsumer = (l: RawLambda) =>
    consumerOf({ file: l.file, line: l.line, fn: l.fn, label: top(l.file), auth: "sqs-lambda", marks: l.marks }, l.reach);
  const deliverTo = (c: Channel, t: Target, timeout?: string) => {
    if (!t.resolved || t.external) return;
    const r = idx.find(t.path);
    if (!r) return;
    const k = routeConsumer(r.route);
    if (timeout && !k.timeout) k.timeout = timeout;
    addEdge({ from: c.id, to: k.id, role: "deliver" });
  };

  // ---- crons: trigger -> schedule channel -> handler ----
  for (const cr of raw.crons) {
    const id = str(cr.kw.schedule_id);
    if (!id) continue;
    const cron = str(cr.kw.cron) ?? "?";
    const dest = str(cr.kw.destination);
    const t = dest ? resolveUrl(dest) : resolveUrl(`{env:API_URL}/v1/internal/crons/${id}`);
    const p: Producer = { id: `p:cron:${id}`, label: humanize(id), file: cr.file, line: cr.line, symbol: "CronJob", lang: "py", trigger: { kind: "cron", cron, scheduleId: id } };
    producers.set(p.id, p);
    const c = chan("qstash-schedule", id, { cron, host: t.host });
    const opts = optsOf("CronJob", cr.kw);
    addEdge({ from: p.id, to: c.id, role: "schedule", opts });
    deliverTo(c, t, opts.timeout);
  }

  // ---- lambdas: which ones consume a queue ----
  const lambdaAt = (file: string, fn: string) => raw.lambdas.find((l) => l.file === file && l.fn === fn);
  const queueConsumers = (q: string): RawLambda[] => {
    const viaEsm = raw.esm.filter((e) => e.queue === q).map((e) => lambdaAt(e.file, e.fn)).filter((l): l is RawLambda => !!l);
    if (viaEsm.length) return viaEsm;
    const byName = raw.lambdas.filter((l) => l.sqs && sameName(q, top(l.file)));
    if (byName.length) return byName;
    // "x_webhook" lambda publishes q -> the "x" lambda drains it
    const dirs = raw.deps.filter((d) => d.queue === q && d.caller.endsWith("_webhook")).map((d) => d.caller.replace(/_webhook$/, ""));
    return raw.lambdas.filter((l) => l.sqs && dirs.includes(top(l.file)));
  };
  // the model's guess is a hint, not a name: it must land on a known queue (or look like one)
  const llmQueue = (k?: string | null) =>
    !k ? null : matchQueue([k], knownQueues) ?? raw.queueEnv.find((e) => e.env === k)?.queue ?? (/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/.test(k) && /[-_]/.test(k) ? k : null);
  const dlqOf = (q: string) => raw.queues.find((x) => x.name === q)?.dlq;
  const sqsChan = (q: string) => {
    const c = chan("sqs", q, { dlq: dlqOf(q) });
    for (const l of queueConsumers(q)) addEdge({ from: c.id, to: lambdaConsumer(l).id, role: "deliver" });
    return c;
  };
  for (const q of raw.queues) if (!/-dlq$/.test(q.name)) sqsChan(q.name);
  for (const r of raw.rules) {
    const p: Producer = { id: `p:eb:${r.id}`, label: humanize(r.id), file: r.file, line: r.line, symbol: r.id, lang: "py", trigger: { kind: "cron", cron: r.cron, scheduleId: r.id } };
    producers.set(p.id, p);
    const c = chan("eventbridge", r.id, { cron: r.cron });
    addEdge({ from: p.id, to: c.id, role: "schedule", opts: { retries: 0 } });
    const l = r.target && lambdaAt(r.target.file, r.target.fn);
    if (l) addEdge({ from: c.id, to: lambdaConsumer(l).id, role: "deliver" });
  }
  const ghSeen = new Map<string, number>();
  for (const g0 of raw.gh) {
    const n = (ghSeen.get(g0.id) ?? 0) + 1;
    ghSeen.set(g0.id, n);
    const g = n > 1 ? { ...g0, id: `${g0.id}-${n}` } : g0;
    const p: Producer = { id: `p:gh:${g.id}`, label: humanize(g.id), file: g.file, line: g.line, symbol: g.id, lang: "py", trigger: { kind: "cron", cron: g.cron, scheduleId: g.id } };
    producers.set(p.id, p);
    const c = chan("gh-cron", g.id, { cron: g.cron });
    addEdge({ from: p.id, to: c.id, role: "schedule", opts: { retries: 0 } });
    const k = consumerOf({ file: g.file, line: g.line, fn: g.id, label: g.id, auth: "unknown" });
    addEdge({ from: c.id, to: k.id, role: "deliver" });
  }

  // ---- publish sites -> channels (+ deliveries) ----
  const planned: { site: RawSite; c: Channel; opts: MsgOptions }[] = [];
  for (const s of raw.sites) {
    if (s.sink || s.wrapper) continue;
    const kw = s.kw;
    const opts = optsOf(s.call, kw, s.via);
    const nf = norm[s.file]?.publishes.find((p) => p.line === s.line || p.symbol === inner(s.fn));
    let c: Channel;
    if (s.call.startsWith("send_message")) {
      const dir = s.file.slice(0, s.file.lastIndexOf("/"));
      const hints = [str(kw.QueueUrl) ?? "", ...(raw.envs[s.file] ?? [])];
      const q =
        matchQueue(hints, knownQueues) ??
        raw.queueEnv.find((e) => e.dir === dir && hints.some((h) => h.includes(e.env)))?.queue ??
        raw.queueEnv.find((e) => e.dir === dir)?.queue ??
        (() => {
          const d = raw.deps.filter((x) => x.caller === top(s.file));
          return d.length === 1 ? d[0].queue : null;
        })() ??
        llmQueue(nf?.channelKey);
      if (!q) unresolved++;
      c = q ? sqsChan(q) : chan("sqs", `?${s.file}:${s.line}`);
    } else {
      const urlExpr = str(kw.url) ?? str(kw.destination);
      if (!urlExpr && !nf?.channelKey) continue; // helper internals / positional args: nothing to draw
      let t = resolveUrl(urlExpr);
      if (!t.resolved && nf?.channelKey) t = resolveUrl(nf.channelKey.startsWith("/") ? nf.channelKey : `/${nf.channelKey}`);
      if (!t.resolved) unresolved++;
      const key = t.resolved ? (t.external ? `${t.host}${t.path}` : t.path) : `?${s.file}:${s.line}`;
      const queue = str(kw.queue) ?? str(kw.queue_name);
      if (s.call === "create_json") {
        const sid = str(kw.schedule_id);
        c = chan("qstash-schedule", sid && !sid.startsWith("{") ? sid : key, { cron: str(kw.cron), host: t.host });
      } else if (queue && !queue.startsWith("{")) c = chan("qstash-queue", queue, { host: t.host });
      else c = chan("qstash-url", key, { host: t.host });
      deliverTo(c, t, opts.timeout);
    }
    planned.push({ site: s, c, opts });
  }

  // ---- sources: who runs the publish ----
  const reachers = (key: string) => [...reachOf].filter(([, r]) => r.includes(key)).map(([id]) => id);
  const httpRoutes = (key: string) => raw.routes.filter((r) => r.reach.includes(key) && !consumers.has(`k:${r.file}:${r.fn}`));
  const eventLambdas = (key: string) => raw.lambdas.filter((l) => !consumers.has(`k:${l.file}:${l.fn}`) && l.reach.includes(key));
  for (const { site: s, c, opts } of planned) {
    const key = `${s.file}:${inner(s.fn)}`;
    let src = reachers(key).filter((id) => delivered.has(id));
    if (!src.length || src.length > 4) {
      const ev = eventLambdas(key);
      const http = httpRoutes(key);
      src = ev.length
        ? ev.map((l) => {
            const id = `p:${l.file}:${l.fn}`;
            producers.set(id, { id, label: humanize(top(l.file)), file: l.file, line: l.line, symbol: l.fn, lang: l.lang, trigger: { kind: "event", source: top(l.file) } });
            return id;
          })
        : http.length && http.length <= 3
          ? http.map((r) => {
              const id = `p:${r.file}:${r.fn}`;
              producers.set(id, { id, label: nameOf(r.fn, r.file), file: r.file, line: r.line, symbol: r.fn, lang: s.lang, trigger: { kind: "http", route: r.path } });
              return id;
            })
          : [];
    }
    if (!src.length) {
      const id = `p:${key}`;
      if (!producers.has(id)) producers.set(id, { id, label: nameOf(s.fn || "main", s.file), file: s.file, line: s.line, symbol: s.fn, lang: s.lang });
      src = [id];
    }
    // failure callback -> consumer (or a bare channel when the route is unknown)
    if (opts.failureCallback) {
      const t = resolveUrl(opts.failureCallback);
      const r = t.resolved ? idx.find(t.path) : null;
      if (r) {
        const k = routeConsumer(r.route);
        addEdge({ from: c.id, to: k.id, role: "callback" });
        opts.failureCallback = k.id;
      } else if (t.resolved) {
        const cc = chan("qstash-url", t.path, { host: t.host });
        addEdge({ from: c.id, to: cc.id, role: "callback" });
        opts.failureCallback = cc.id;
      }
    }
    for (const from of src) {
      const loop = delivered.get(from)?.has(c.id);
      addEdge({ from, to: c.id, role: loop ? "loop" : "publish", opts });
    }
  }

  // ---- dependency map seeds: sqs edges the code scan could not see ----
  for (const d of raw.deps) {
    const c = sqsChan(d.queue);
    const has = [...edges.values()].some((e) => e.to === c.id && (e.from.includes(`:${d.caller}/`) || e.from.startsWith(`p:svc:${d.caller}`)));
    if (has) continue;
    const l = raw.lambdas.find((x) => top(x.file) === d.caller);
    let from: string;
    if (l && consumers.has(`k:${l.file}:${l.fn}`)) from = `k:${l.file}:${l.fn}`;
    else if (l) {
      from = `p:${l.file}:${l.fn}`;
      if (!producers.has(from)) producers.set(from, { id: from, label: humanize(d.caller), file: l.file, line: l.line, symbol: l.fn, lang: l.lang, trigger: { kind: "event", source: d.caller } });
    } else {
      from = `p:svc:${d.caller}`;
      producers.set(from, { id: from, label: humanize(d.caller), file: d.caller, line: 1, symbol: d.caller, lang: "py" });
    }
    addEdge({ from, to: c.id, role: "publish", opts: {} });
  }

  return { producers: [...producers.values()], channels: [...channels.values()], consumers: [...consumers.values()], edges: [...edges.values()], unresolved };
}
