// §6 queue fixtures against the real webapp repo (deterministic pass only; no LLM), plus pure unit tests.
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { cluster, domainOf } from "./cluster";
import { domainGraph, MAX_QUEUE_NODES, overview, subgraph } from "./graph";
import { cronHuman, link, optsOf } from "./link";
import { applyQueueOps, diffTopologies, toTopology } from "./ops";
import { matchQueue, resolveUrl, setAppHosts } from "./resolve";
import { cronEveryMin, queueRisks } from "./risk";
import { RouteIndex } from "./routes";
import { enclosing, extract, hitFiles, regexPy } from "./scan";
import type { QEdge, RawScan, Topology } from "./types";

const REPO = process.env.LAMBDA_TEST_REPO ?? ""; // real-repo fixtures run only when set
const APP_HOSTS = (process.env.LAMBDA_TEST_APP_HOSTS ?? "").split(",").filter(Boolean); // that repo's own API hosts
const IGNORE = ["node_modules", ".git", ".next", "venv", ".venv", "dist", "build", "__pycache__"];

describe.skipIf(!fs.existsSync(REPO))("queue topology: real repo", () => {
  let raw: RawScan;
  let t: Topology;
  const out = (id: string, role?: QEdge["role"]) => t.edges.filter((e) => e.from === id && (!role || e.role === role));
  const into = (id: string, role?: QEdge["role"]) => t.edges.filter((e) => e.to === id && (!role || e.role === role));
  const consumer = (route: string) => t.consumers.find((k) => k.route === route);

  beforeAll(async () => {
    setAppHosts(APP_HOSTS);
    raw = await extract(REPO, IGNORE);
    t = toTopology(link(raw), { sig: "test", files: raw.files.length });
  }, 120_000);

  it("finds the cron jobs and publish sites", () => {
    expect(raw.engine).toBe("python");
    expect(raw.crons.length).toBeGreaterThanOrEqual(115);
    expect(t.producers.filter((p) => p.trigger?.kind === "cron" && p.id.startsWith("p:cron:")).length).toBeGreaterThanOrEqual(115);
    expect(raw.sites.filter((s) => s.lang === "py" && s.file.startsWith("api/")).length).toBeGreaterThanOrEqual(130);
  });

  it("review fixes: None defaults, helper call sites, multi-return builders, sqs constants", () => {
    expect(raw.sites.filter((s) => /^None\//.test(String(s.kw.url ?? s.kw.destination ?? "")))).toEqual([]);
    const delivered = (key: string) => out(`c:qstash-url:${key}`, "deliver").length > 0;
    expect(delivered("/v1/demo-bookings/attendance-proxy/process")).toBe(true);
    expect(delivered("/v1/internal/sales-demo-events/reminder-process")).toBe(true);
    expect(delivered("/v1/demo-bookings/reminders/process")).toBe(true);
    expect(t.channels.some((c) => c.key.includes("{route_path}") || c.key.endsWith("sales-demo-events{}"))).toBe(false);
    const drafts = t.edges.filter((e) => e.from.includes("_enqueue_entity_drafts_for_campaign")).map((e) => e.to);
    expect(drafts).toEqual(expect.arrayContaining(["c:qstash-url:/v1/draft/podcast", "c:qstash-url:/v1/draft/newsletter", "c:qstash-url:/v1/draft/linkedin"]));
    expect(into("c:sqs:outlook-notifications").some((e) => e.from.includes("backfill_outlook_webhooks"))).toBe(true);
  });

  it("regex fallback still sees crons, sites and routes", () => {
    const r = regexPy(hitFiles(REPO, IGNORE));
    expect(r.crons.length).toBeGreaterThanOrEqual(100);
    expect(r.pubs.length).toBeGreaterThanOrEqual(80);
    expect(r.routes.some((x) => x.auth === "qstash-sig")).toBe(true);
  });

  it("edge 1: resume_due_campaigns -> /schedule -> schedule_email", () => {
    const e = t.edges.find((x) => x.from.includes("resume_due_campaigns") && x.to === "c:qstash-url:/schedule");
    expect(e?.opts).toMatchObject({ retries: 3, flow: { key: "campaign-schedule", parallelism: 10 }, fanout: "batch" });
    expect(out("c:qstash-url:/schedule", "deliver").map((x) => t.consumers.find((k) => k.id === x.to)?.symbol)).toContain("schedule_email");
  });

  it("edge 2: /match/itunes flow 20, 5 per 1m, no retries", () => {
    const e = into("c:qstash-url:/match/itunes").find((x) => x.from.includes("dispatch_podcast_auto_matching"));
    expect(e?.opts).toMatchObject({ retries: 0, flow: { parallelism: 20, rate: 5, period: "1m" } });
  });

  it("edge 8: targeting_v2 runs loop + failure callback to /runs/fail", () => {
    const c = "c:qstash-url:/match/targeting-v2/runs/process";
    expect(t.edges.some((e) => e.to === c && e.role === "loop")).toBe(true);
    const cb = out(c, "callback").map((e) => t.consumers.find((k) => k.id === e.to));
    expect(cb.some((k) => k?.route === "/match/targeting-v2/runs/fail")).toBe(true);
  });

  it("edge 10: demo leads -> /sync-klaviyo with retries, backoff, deterministic dedup, poison handling", () => {
    const c = "c:qstash-url:/v1/podcast-demo-leads/sync-klaviyo";
    const e = into(c).find((x) => x.role !== "callback" && x.opts?.retries === 5);
    expect(e?.opts?.retryDelay).toBeTruthy();
    expect(e?.opts?.dedup).toBe("deterministic");
    expect(consumer("/v1/podcast-demo-leads/sync-klaviyo")?.nonRetryable).toBe(true);
    expect(consumer("/v1/podcast-demo-leads/sync-klaviyo")?.auth).toBe("qstash-sig");
  });

  it("edge 14: a qstash queue delivers to /v1/journo/import", () => {
    const k = consumer("/v1/journo/import");
    expect(k).toBeTruthy();
    expect(into(k!.id, "deliver").some((e) => t.channels.find((c) => c.id === e.from)?.kind === "qstash-queue")).toBe(true);
  });

  it("edge 16: bulkRewrite.ts -> /api/ai-rewrite-webhook (Receiver)", () => {
    const k = consumer("/api/ai-rewrite-webhook");
    expect(k?.auth).toBe("receiver");
    const c = into(k!.id, "deliver")[0]?.from;
    const p = into(c!).map((e) => t.producers.find((x) => x.id === e.from));
    expect(p.some((x) => x?.lang === "ts" && x.file.endsWith("bulkRewrite.ts"))).toBe(true);
  });

  it("edge 17: cron enqueue-tracking-events -> /track/enqueue_sqs -> sqs reply-tracking -> lambda (>= 4 hops)", () => {
    const start = "p:cron:enqueue-tracking-events";
    const seen = new Map<string, number>([[start, 0]]);
    const q = [start];
    while (q.length) {
      const n = q.shift()!;
      for (const e of out(n)) {
        if (seen.has(e.to)) continue;
        seen.set(e.to, seen.get(n)! + 1);
        q.push(e.to);
      }
    }
    const k = consumer("/track/enqueue_sqs");
    expect(k && seen.has(k.id)).toBe(true);
    expect(seen.has("c:sqs:reply-tracking")).toBe(true);
    const lambda = t.consumers.find((x) => x.auth === "sqs-lambda" && x.file.startsWith("reply_tracking/"));
    expect(lambda && seen.get(lambda.id)).toBeGreaterThanOrEqual(4);
  });

  it("risks: staging targets, sqs dead letter", () => {
    const staging = t.risks.filter((r) => r.rule === "points-at-staging").map((r) => r.target.id);
    expect(staging).toContain("c:qstash-schedule:enqueue-tracking-events");
    const hub = t.edges.filter((e) => e.from.includes("sync_profile_goals_hubspot")).map((e) => e.to);
    expect(hub.some((c) => staging.includes(c))).toBe(true);
    expect(t.channels.find((c) => c.id === "c:sqs:podcast-email-enrichment")?.dlq).toBe("podcast-email-enrichment-dlq");
  });

  it("domains: sendblue -> sms, /match/* -> matching", () => {
    const dom = new Map(t.domains.flatMap((d) => d.nodeIds.map((n) => [n, d.id] as const)));
    const sb = t.channels.filter((c) => c.key.includes("/sendblue/"));
    expect(sb.length).toBeGreaterThan(0);
    for (const c of sb) expect(dom.get(c.id)).toBe("sms");
    const mt = t.channels.filter((c) => c.key.startsWith("/match/"));
    expect(mt.length).toBeGreaterThan(0);
    for (const c of mt) expect(dom.get(c.id)).toBe("matching");
  });

  it("views stay small", () => {
    const o = overview(t);
    expect(JSON.stringify(o).length).toBeLessThan(50_000);
    for (const d of t.domains) {
      const g = domainGraph(t, d.id)!;
      expect(g.nodes.length).toBeLessThanOrEqual(MAX_QUEUE_NODES);
      for (const p of g.parts ?? []) expect(domainGraph(t, d.id, p.id)!.nodes.length).toBeLessThanOrEqual(MAX_QUEUE_NODES);
      for (const n of g.nodes) expect(n.label.split(/\s+/).length).toBeLessThanOrEqual(4);
    }
    for (const r of t.risks) {
      expect(r.label.split(" ").length).toBeLessThanOrEqual(3);
      expect(r.why.split(" ").length).toBeLessThanOrEqual(12);
    }
  });

  it("git replay: an edited publish site diffs into ops", async () => {
    const file = "api/cron/jobs/dispatch_podcast_auto_matching.py";
    const text = fs.readFileSync(`${REPO}/${file}`, "utf8").replace("flow_control_parallelism=20", "flow_control_parallelism=40");
    const after = toTopology(link(await extract(REPO, IGNORE, { [file]: text })), { sig: "b", files: 0 });
    const ops = diffTopologies(t, after);
    expect(ops.some((o) => o.op === "change_opts" && o.edge.includes("dispatch_podcast_auto_matching") && o.opts.flow?.parallelism === 40)).toBe(true);
  }, 120_000);
});

// ---------- pure units ----------

const mini = (): Topology => {
  const l = link({
    sites: [
      { file: "api/jobs/a.py", line: 3, end: 5, fn: "kick", lang: "py", call: "batch_enqueue", kw: { url: "{env:API_URL}/work", retries: 2 } },
      { file: "api/routes/w.py", line: 9, end: 9, fn: "work", lang: "py", call: "publish_json", kw: { url: "{env:API_URL}/work", deduplication_id: "w-{id}", flow_control: { key: "w", parallelism: 1 } } },
    ],
    routes: [{ file: "api/routes/w.py", line: 1, fn: "work", method: "post", path: "/work", auth: "none", marks: [], reach: ["api/routes/w.py:work"] }],
    crons: [], lambdas: [], queues: [], esm: [], rules: [], gh: [], deps: [], queueEnv: [], envs: {}, files: [], engine: "python",
  });
  return toTopology(l, { sig: "s", files: 2 });
};

describe("queue engine units", () => {
  it("resolves urls to channel keys", () => {
    expect(resolveUrl("{env:API_URL}/match/itunes")).toMatchObject({ path: "/match/itunes", resolved: true, staging: false });
    setAppHosts(["example"]);
    expect(resolveUrl("https://api-staging.example.com/track/x?y=1")).toMatchObject({ path: "/track/x", staging: true, external: false });
    expect(resolveUrl("{env:API_URL}/runs/{run_id}/go").path).toBe("/runs/{}/go");
    expect(resolveUrl("{url}").resolved).toBe(false);
    expect(resolveUrl("https://hooks.slack.com/a").external).toBe(true);
  });

  it("matches queues from env names", () => {
    expect(matchQueue(["REPLY_TRACKING_SQS_QUEUE_URL"], ["reply-tracking", "reply-categorizer"])).toBe("reply-tracking");
    expect(matchQueue(["{categorizer_queue_url}"], ["reply-tracking", "reply-categorizer"])).toBe("reply-categorizer");
    expect(matchQueue(["SQS_URL"], ["reply-tracking"])).toBeNull();
  });

  it("an llm queue guess must land on a known queue", () => {
    const base = { routes: [], crons: [], lambdas: [], esm: [], rules: [], gh: [], deps: [], queueEnv: [], envs: {}, files: [], engine: "python" as const };
    const site = { file: "scripts/b.py", line: 4, end: 4, fn: "send", lang: "py" as const, call: "send_message", kw: { QueueUrl: "{q}" } };
    const norm = (k: string) => ({ "scripts/b.py": { publishes: [{ symbol: "send", line: 4, channelKey: k, opts: {} }], consumers: [] } });
    const chans = (k: string) => link({ ...base, sites: [site], queues: [{ name: "outlook-notifications" }] }, norm(k)).edges.filter((e) => e.role === "publish").map((e) => e.to);
    expect(chans("outlook-notifications")).toEqual(["c:sqs:outlook-notifications"]);
    expect(chans("OUTLOOK_QUEUE_NAME")).toEqual(["c:sqs:?scripts/b.py:4"]);
  });

  it("route index matches params and prefers POST", () => {
    const idx = new RouteIndex([
      { file: "a", line: 1, fn: "g", method: "get", path: "/x/{id}", auth: "unknown", marks: [], reach: [] },
      { file: "a", line: 2, fn: "p", method: "post", path: "/x/{id}", auth: "unknown", marks: [], reach: [] },
    ]);
    expect(idx.find("/x/{}")?.fn).toBe("p");
    expect(idx.find("/y")).toBeNull();
  });

  it("maps message options", () => {
    expect(optsOf("publish_json", { retries: 3, delay: 5, deduplication_id: "{uuid4}", flow_control: { key: "k", ratePerSecond: 3 } })).toMatchObject({
      retries: 3, delay: "5s", dedup: "random", flow: { key: "k", rate: 3, period: "1s" }, fanout: "single",
    });
    expect(optsOf("batch_enqueue", { timeout_ms: 60000 })).toMatchObject({ retries: 0, timeout: "60s", fanout: "batch" });
  });

  it("links self re-publish as a loop and fires risk rules", () => {
    const t = mini();
    expect(t.edges.find((e) => e.role === "loop")?.from).toBe("k:api/routes/w.py:work");
    const rules = new Set(t.risks.map((r) => r.rule));
    for (const r of ["unauthenticated", "unthrottled-fanout", "no-dead-letter", "not-idempotent"]) expect(rules).toContain(r);
    expect(rules).not.toContain("runaway-loop"); // dedup + flow on the loop
  });

  it("cron interval parsing", () => {
    expect(cronEveryMin("*/5 * * * *")).toBe(5);
    expect(cronEveryMin("* * * * *")).toBe(1);
    expect(cronEveryMin("0 1 * * *")).toBeNull();
    expect(["*/5 * * * *", "0 1 * * *", "0 * * * *", "* * * * *", "0 13 * * 1", "17 1,4,7 * * *"].map(cronHuman)).toEqual([
      "every 5m", "daily 1am", "hourly", "every minute", "weekly 1pm", "3x daily",
    ]);
  });

  it("domain rules", () => {
    expect(domainOf("/v1/sendblue/retry-process")).toBe("sms");
    expect(domainOf("/match/itunes")).toBe("matching");
    expect(domainOf("/nothing/here")).toBe("misc");
    expect(cluster(mini()).flatMap((d) => d.nodeIds).length).toBe(mini().producers.length + mini().channels.length + mini().consumers.length);
  });

  it("applies ops with diff states and recomputes risks", () => {
    const t = mini();
    const { topo, diff } = applyQueueOps(t, [
      { op: "add_channel", id: "c:qstash-url:/new", kind: "qstash-url", key: "/new" },
      { op: "add_consumer", id: "k:new", label: "new worker", route: "/new", idempotency: "lock", auth: "qstash-sig" },
      { op: "add_edge", from: "c:qstash-url:/new", to: "k:new", role: "deliver" },
      { op: "remove", id: "k:api/routes/w.py:work" },
    ]);
    expect(diff.get("c:qstash-url:/new")).toBe("added");
    expect(diff.get("k:api/routes/w.py:work")).toBe("removed");
    expect(topo.risks.some((r) => r.target.id === "k:api/routes/w.py:work")).toBe(false);
    const g = subgraph(topo, new Set(diff.keys()), { title: "p", diff });
    expect(g.nodes.find((n) => n.id === "k:new")?.diff).toBe("added");
    expect(diffTopologies(t, topo).some((o) => o.op === "add_consumer")).toBe(true);
  });

  it("collapses crowded siblings into +N", () => {
    const t = mini();
    for (let i = 0; i < 8; i++) {
      t.producers.push({ id: `p:x${i}`, label: `x ${i}`, file: "f", line: i, symbol: `x${i}`, lang: "py" });
      t.edges.push({ id: `p:x${i}>c:qstash-url:/work:publish`, from: `p:x${i}`, to: "c:qstash-url:/work", role: "publish" });
    }
    t.domains = cluster(t);
    t.risks = queueRisks(t);
    const g = subgraph(t, new Set(t.domains.flatMap((d) => d.nodeIds)), { title: "x" });
    expect(g.nodes.some((n) => n.kind === "more")).toBe(true);
    expect(g.nodes.length).toBeLessThanOrEqual(MAX_QUEUE_NODES);
  });

  it("finds the enclosing python function", () => {
    const src = "x = 1\n\nasync def f(a):\n    if a:\n        go(a)\n    return 2\n\ndef g():\n    pass\n";
    expect(enclosing(src, 5, "py")).toMatchObject({ start: 3, end: 7, name: "f" });
  });
});
