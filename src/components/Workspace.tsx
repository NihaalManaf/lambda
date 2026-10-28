"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { Feature, Job, JobKind } from "@/lib/types";
import ChatDock from "@/components/chat/ChatDock";
import ContextTab from "./context/ContextTab";
import FlowTab from "./flow/FlowTab";
import MockupTab from "./mockup/MockupTab";
import QueuesTab from "./queues/QueuesTab";
import SchemaTab from "./schema/SchemaTab";
import StoriesTab from "./stories/StoriesTab";
import VerifyTab from "./verify/VerifyTab";

const TABS = [
  { key: "stories", label: "stories", job: "stories", n: (f: Feature) => f.stories.length, C: StoriesTab },
  { key: "flows", label: "flows", job: "flows", n: (f: Feature) => f.flowcharts.reduce((a, s) => a + s.charts.length, 0), C: FlowTab },
  { key: "schema", label: "schema", job: "schema", n: (f: Feature) => f.schema?.length ?? 0, C: SchemaTab },
  { key: "queues", label: "queues", job: "queues", n: (f: Feature) => f.queues?.length ?? 0, C: QueuesTab },
  { key: "sketch", label: "ui sketch", job: null, n: (f: Feature) => f.mockups.length, C: MockupTab },
  { key: "verify", label: "verify", job: null, n: (f: Feature) => f.runs.length, C: VerifyTab },
  { key: "context", label: "context", job: "context", n: (f: Feature) => f.context.length, C: ContextTab },
] as const;

type TabKey = (typeof TABS)[number]["key"];

// schema + queues are per-feature visualizers: only when the feature needs them (or already has proposals)
const shown = (f: Feature, k: TabKey) =>
  k === "schema" ? !!f.needs?.schema || !!f.schema?.length : k === "queues" ? !!f.needs?.queues || !!f.queues?.length : true;

// fields each job writes; a finished job's fields are the only ones a poll may replace
const OWNS: Record<JobKind, (keyof Feature)[]> = {
  context: ["context", "discovery"],
  stories: ["stories", "sizing"],
  flows: ["flowcharts"],
  schema: ["schema"],
  queues: ["queues"],
};

// a flow ref may be a set, chart, node, edge or edge case id → the chart card that holds it
function flowSelector(f: Feature, ref: string): string | null {
  for (const set of f.flowcharts) {
    if (set.id === ref) return set.charts[0] ? `#chart-${CSS.escape(set.charts[0].id)}` : null;
    const c = set.charts.find(
      (c) => c.id === ref || c.nodes.some((n) => n.id === ref) || c.edges.some((e) => e.id === ref) || c.edgeCases.some((x) => x.id === ref),
    );
    if (c) return `#chart-${CSS.escape(c.id)}`;
  }
  return null;
}

const active = (j?: Job) => j?.status === "queued" || j?.status === "running";
const jobOf = (f: Feature, k: JobKind) => f.jobs?.find((j) => j.kind === k);
const POLL_MS = 1500;
const isEmpty = (f: Feature) => !f.stories.length && !f.flowcharts.length && !f.context.some((c) => c.auto) && !f.jobs?.length;

export default function Workspace({ initial }: { initial: Feature }) {
  const [feature, setFeature] = useState(initial);
  const [tab, setTab] = useState<TabKey>("stories");
  const [visited, setVisited] = useState<TabKey[]>(["stories"]);
  const [flash, setFlash] = useState<JobKind[]>([]); // tabs that just finished: tiny ✓
  const reduce = useReducedMotion();

  const tabs = useMemo(() => TABS.filter((t) => shown(feature, t.key)), [feature]);
  const tabKeys = useRef<TabKey[]>(tabs.map((t) => t.key));
  useEffect(() => {
    tabKeys.current = tabs.map((t) => t.key);
  }, [tabs]);

  const open = useCallback((k: TabKey) => {
    setTab(k); // underline + selection move this frame
    // mounting a heavy tab (react flow, sketch canvas) is interruptible work, not a frame drop
    startTransition(() => setVisited((v) => (v.includes(k) ? v : [...v, k])));
  }, []);

  // ---------- lambda:focus {tab, ref} (chat change cards, "run in browser") ----------
  // switch to the tab; stories scrolls itself, everything else is found by data-focus-id / chart anchor
  const live = useRef(feature);
  useEffect(() => {
    live.current = feature;
  }, [feature]);
  useEffect(() => {
    let timer = 0;
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ tab?: string; ref?: string; scope?: string }>).detail;
      if (!d?.tab) return;
      const smooth = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
      if (d.tab === "overview") return window.scrollTo({ top: 0, behavior: smooth });
      const k = d.tab as TabKey;
      if (!tabKeys.current.includes(k) && !TABS.some((t) => t.key === k)) return;
      open(k);
      const ref = d.ref;
      if (!ref || k === "stories") return;
      const sel = k === "flows" ? flowSelector(live.current, d.scope ?? ref) ?? flowSelector(live.current, ref) : `[data-focus-id="${CSS.escape(ref)}"]`;
      if (!sel) return;
      let tries = 0;
      const find = () => {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el || !el.offsetParent) return void (++tries < 40 && requestAnimationFrame(find)); // tab / lens still landing
        el.scrollIntoView({ behavior: smooth, block: "center" });
        el.classList.remove("focus-pulse");
        void el.offsetWidth; // restart the animation on repeat clicks
        el.classList.add("focus-pulse");
        window.clearTimeout(timer);
        timer = window.setTimeout(() => el.classList.remove("focus-pulse"), 1700);
      };
      requestAnimationFrame(find);
    };
    window.addEventListener("lambda:focus", on);
    return () => {
      window.removeEventListener("lambda:focus", on);
      window.clearTimeout(timer);
    };
  }, [open]);

  // ---------- background jobs: poll + merge ----------

  const seen = useRef<Job[] | undefined>(initial.jobs); // last server job snapshot

  const absorb = useCallback((server: Feature) => {
    const before = seen.current ?? [];
    seen.current = server.jobs;
    const finished = (server.jobs ?? [])
      .filter((j) => j.status === "done" && before.find((b) => b.kind === j.kind)?.finishedAt !== j.finishedAt)
      .map((j) => j.kind);
    setFeature((local) => {
      const next: Feature = { ...local, jobs: server.jobs, needs: server.needs, discovery: server.discovery };
      for (const k of finished) for (const field of OWNS[k]) (next as unknown as Record<string, unknown>)[field] = server[field];
      return next;
    });
    if (finished.length) {
      setFlash((x) => [...new Set([...x, ...finished])]);
      window.setTimeout(() => setFlash((x) => x.filter((k) => !finished.includes(k))), 1800);
    }
  }, []);

  const anyActive = !!feature.jobs?.some(active);
  useEffect(() => {
    if (!anyActive) return;
    let stop = false;
    let t = 0;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const res = await fetch(`/api/features/${feature.id}/jobs`, { cache: "no-store" });
          if (res.ok && !stop) absorb(await res.json());
        } catch {
          /* transient: next tick */
        }
      }
      if (!stop) t = window.setTimeout(tick, POLL_MS);
    };
    t = window.setTimeout(tick, POLL_MS);
    return () => {
      stop = true;
      window.clearTimeout(t);
    };
  }, [anyActive, feature.id, absorb]);

  const [starting, setStarting] = useState(false);
  const run = useCallback(
    async (kinds?: JobKind[]) => {
      setStarting(true);
      // optimistic: dots + tabs appear before the round trip
      setFeature((f) => {
        const ks: JobKind[] = kinds ?? ["context", "stories", "flows"];
        const jobs = [...(f.jobs ?? []).filter((j) => !ks.includes(j.kind)), ...ks.map((kind): Job => ({ kind, status: "queued" }))];
        const needs =
          kinds?.includes("schema") || kinds?.includes("queues")
            ? { schema: !!f.needs?.schema || !!kinds?.includes("schema"), queues: !!f.needs?.queues || !!kinds?.includes("queues"), why: f.needs?.why ?? "added by hand" }
            : f.needs;
        return { ...f, jobs, needs };
      });
      if (kinds?.length === 1 && (kinds[0] === "schema" || kinds[0] === "queues")) open(kinds[0]);
      try {
        const res = await fetch(`/api/features/${feature.id}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(kinds ? { kinds } : {}),
        });
        if (res.ok) absorb(await res.json());
      } finally {
        setStarting(false);
      }
    },
    [feature.id, absorb, open],
  );

  // ---------- idle warm-up ----------

  // warm the other tabs while the page is idle, one per idle slice, so the first click is instant
  useEffect(() => {
    const ric =
      window.requestIdleCallback ?? ((cb: IdleRequestCallback) => window.setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 0 }), 200));
    const cic = window.cancelIdleCallback ?? window.clearTimeout;
    let handle = 0;
    let gap = 0;
    let n = 0;
    const next = () => {
      handle = ric(
        () => {
          startTransition(() =>
            setVisited((v) => {
              const k = tabKeys.current.find((key) => !v.includes(key));
              return k ? [...v, k] : v;
            }),
          );
          if (++n < TABS.length) gap = window.setTimeout(next, 150);
        },
        { timeout: 2500 },
      );
    };
    const start = window.setTimeout(next, 600); // after the entrance settles
    return () => {
      window.clearTimeout(start);
      window.clearTimeout(gap);
      cic(handle);
    };
  }, []);

  const failed = (feature.jobs ?? []).filter((j) => j.status === "error");
  const ghosts = (["schema", "queues"] as const).filter((k) => !shown(feature, k));

  return (
    <main className="mx-auto min-w-0 max-w-7xl px-4 pb-28 pt-8 md:px-6 md:pt-10 lg:[html[data-dock=open]_&]:mr-[400px]">
      <div className="eyebrow mb-3">{feature.status}</div>
      <h1 className="display break-words text-4xl md:text-6xl">{feature.title}</h1>
      <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-2">{feature.brief}</p>

      {/* one obvious action for features made before auto-generation; errors as retry chips */}
      <AnimatePresence initial={false}>
        {(isEmpty(feature) || failed.length > 0) && (
          <motion.div
            initial={{ opacity: 0, y: reduce ? 0 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="mt-6 flex flex-wrap items-center gap-2"
          >
            {isEmpty(feature) && (
              <button className="btn btn-primary" disabled={starting} onClick={() => run()}>
                <span aria-hidden>✦</span> generate everything
              </button>
            )}
            {failed.map((j) => (
              <button
                key={j.kind}
                title={j.error}
                onClick={() => run([j.kind])}
                className="chip !border-bad/40 text-bad transition-transform active:scale-[0.97]"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-bad" /> {j.kind} failed · retry
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className="no-scrollbar -mx-4 mt-8 flex items-center gap-1 overflow-x-auto whitespace-nowrap border-b border-line px-4 md:mx-0 md:mt-10 md:px-0"
        role="tablist"
      >
        {tabs.map((t) => {
          const j = t.job ? jobOf(feature, t.job) : undefined;
          return (
            <motion.button
              key={t.key}
              layout={reduce ? false : "position"}
              transition={{ type: "spring", stiffness: 500, damping: 40 }}
              role="tab"
              aria-selected={tab === t.key}
              aria-busy={active(j) || undefined}
              onClick={() => open(t.key)}
              className={`relative flex shrink-0 items-center whitespace-nowrap px-3 pb-3 pt-2 text-sm transition-colors md:px-4 ${tab === t.key ? "text-ink" : "text-grey hover:text-ink-2"}`}
            >
              {t.label}
              {t.n(feature) > 0 && <span className="ml-1.5 font-mono text-[11px] text-grey">{t.n(feature)}</span>}
              <TabSignal job={j} flash={!!t.job && flash.includes(t.job)} reduce={!!reduce} />
              {tab === t.key && (
                <motion.span
                  layoutId="tab-underline"
                  className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-ink"
                  transition={{ type: "spring", stiffness: 500, damping: 40 }}
                />
              )}
            </motion.button>
          );
        })}
        {ghosts.length > 0 && <span className="mx-1 h-4 w-px shrink-0 bg-line" aria-hidden />}
        {ghosts.map((k) => (
          <button
            key={k}
            onClick={() => run([k])}
            title={k === "schema" ? "add a db schema view" : "add a queue/jobs view"}
            className="mb-1.5 shrink-0 rounded-full border border-dashed border-line-2 px-2.5 py-0.5 font-mono text-[11px] text-grey transition-[color,border-color,transform] duration-150 hover:border-ink-2 hover:text-ink active:scale-[0.97]"
          >
            + {k}
          </button>
        ))}
      </div>

      {/* visited tabs stay mounted (inert + hidden) so in-flight model work keeps its state */}
      <div className="relative pt-8">
        {tabs
          .filter((t) => visited.includes(t.key))
          .map((t) => {
            const on = t.key === tab;
            return (
              <motion.section
                key={t.key}
                inert={!on}
                aria-hidden={!on}
                initial={{ opacity: 0, y: 6 }}
                animate={on ? { opacity: 1, y: 0 } : { opacity: 0, y: 0 }}
                transition={{ duration: on ? 0.22 : 0, ease: [0.22, 1, 0.36, 1] }}
                className={on ? "relative" : "pointer-events-none invisible absolute inset-x-0 top-8 h-0 overflow-hidden"}
              >
                <t.C feature={feature} onChange={setFeature} />
              </motion.section>
            );
          })}
      </div>

      <ChatDock feature={feature} onChange={setFeature} />
    </main>
  );
}

// running: soft pulsing lilac dot · just done: ✓ that fades · error: red dot
function TabSignal({ job, flash, reduce }: { job?: Job; flash: boolean; reduce: boolean }) {
  const state = active(job) ? "busy" : flash ? "done" : job?.status === "error" ? "error" : null;
  return (
    <span className="relative ml-1.5 inline-grid h-3 w-3 place-items-center" aria-hidden={!state}>
      <AnimatePresence mode="popLayout" initial={false}>
        {state === "busy" && (
          <motion.span
            key="busy"
            initial={{ opacity: 0, scale: reduce ? 1 : 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            className="relative grid h-3 w-3 place-items-center"
            title={job?.status === "queued" ? "queued" : "generating"}
          >
            <span className="absolute h-2.5 w-2.5 animate-ping rounded-full bg-lilac/70 [animation-duration:1.6s]" />
            <span className="relative h-1.5 w-1.5 rounded-full bg-lilac" />
          </motion.span>
        )}
        {state === "done" && (
          <motion.span
            key="done"
            initial={{ opacity: 0, scale: reduce ? 1 : 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.25 } }}
            transition={{ type: "spring", stiffness: 520, damping: 26 }}
            className="font-mono text-[11px] leading-none text-ok"
            title="done"
          >
            ✓
          </motion.span>
        )}
        {state === "error" && (
          <motion.span
            key="err"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-1.5 w-1.5 rounded-full bg-bad"
            title={job?.error ?? "failed"}
          />
        )}
      </AnimatePresence>
    </span>
  );
}
