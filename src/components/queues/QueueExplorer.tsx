"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import type { Risk } from "@/lib/types";
import type { QGNode, QueueGraph, ScanStatus } from "@/lib/queues/types";
import RiskList from "@/components/viz/RiskList";
import QueueCanvas from "./QueueCanvas";
import DomainMap from "./DomainMap";
import NodeDrawer from "./NodeDrawer";
import ScanBar, { running } from "./ScanBar";
import { QCtx } from "./qNodes";

// /queues: scan bar on top, domain map → domain view (spring zoom from the clicked card), rail on the right.

type Overview = { status: ScanStatus; overview: QueueGraph | null; stats?: { scannedAt?: string } };
type View = { domain: string; label: string; part: string | null; graph: QueueGraph };

const zoom = { type: "spring", duration: 0.22, bounce: 0.12 } as const;
const pillSpring = { type: "spring", stiffness: 500, damping: 40 } as const;

export default function QueueExplorer() {
  const [data, setData] = useState<Overview | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [origin, setOrigin] = useState("50% 50%");
  const [selected, setSelected] = useState<QGNode | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef(new Map<string, Promise<QueueGraph>>());
  const box = useRef<HTMLDivElement>(null);
  const wasBusy = useRef(false);

  const refresh = useCallback(() => {
    fetch("/api/queues")
      .then((r) => (r.ok ? (r.json() as Promise<Overview>) : Promise.reject(new Error(r.statusText))))
      .then((d) => {
        const busy = running(d.status);
        if (wasBusy.current && !busy) cache.current.clear(); // fresh topology: drop stale domain views
        wasBusy.current = busy;
        setData(d);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(refresh, [refresh]);

  const busy = running(data?.status);
  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(refresh, 1000);
    return () => window.clearInterval(t);
  }, [busy, refresh]);

  const graphFor = useCallback((domain: string, part: string | null) => {
    const k = `${domain}|${part ?? ""}`;
    let p = cache.current.get(k);
    if (!p) {
      p = fetch(`/api/queues/domains/${encodeURIComponent(domain)}${part ? `?part=${encodeURIComponent(part)}` : ""}`).then((r) =>
        r.ok ? (r.json() as Promise<QueueGraph>) : Promise.reject(new Error(r.statusText)),
      );
      p.catch(() => cache.current.delete(k));
      cache.current.set(k, p);
    }
    return p;
  }, []);

  function open(domain: string, label: string, at: { x: number; y: number }) {
    const r = box.current?.getBoundingClientRect();
    if (r) setOrigin(`${Math.round(at.x - r.left)}px ${Math.round(at.y - r.top)}px`);
    setPending(domain);
    graphFor(domain, null)
      .then((graph) => {
        setSelected(null);
        setView({ domain, label, part: null, graph });
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setPending(null));
  }

  function pickPart(part: string) {
    if (!view) return;
    const { domain } = view;
    graphFor(domain, part)
      .then((graph) => {
        setSelected(null);
        setView((v) => (v && v.domain === domain ? { ...v, part, graph } : v));
      })
      .catch((e: Error) => setError(e.message));
  }

  const back = useCallback(() => {
    setSelected(null);
    setView(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target as HTMLElement)?.closest?.("input,textarea")) return;
      if (selected) setSelected(null);
      else if (view) back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, view, back]);

  function scan() {
    setError(null);
    fetch("/api/queues/scan", { method: "POST" })
      .then((r) => (r.ok ? (r.json() as Promise<ScanStatus>) : Promise.reject(new Error(r.statusText))))
      .then((status) => {
        wasBusy.current = true;
        setData((d) => ({ overview: d?.overview ?? null, stats: d?.stats, status }));
      })
      .catch((e: Error) => setError(e.message));
  }

  const graph = view?.graph ?? data?.overview ?? null;

  function focusRisk(r: Risk) {
    if (!graph) return;
    const t = r.target;
    const id = t.kind === "edge" ? graph.edges.find((e) => e.id === t.id)?.to : t.id;
    const n = graph.nodes.find((x) => x.id === id);
    if (n) setSelected(n);
    setHover(r.id);
  }

  const parts = view?.graph.parts;
  const activePart = view?.part ?? parts?.[0]?.id;

  return (
    <QCtx.Provider value={{ hover, setHover, selected: selected?.id ?? null, focus: null }}>
      <div className="space-y-4">
        <ScanBar status={data?.status ?? null} scannedAt={data?.stats?.scannedAt} onScan={scan} />

        {/* breadcrumb + parts */}
        <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-2">
          <nav className="flex items-baseline gap-1.5 font-mono text-[12px]">
            <button onClick={back} className={clsx("transition-colors", view ? "text-grey hover:text-ink" : "text-ink")} disabled={!view}>
              all
            </button>
            <AnimatePresence initial={false}>
              {view && (
                <motion.span key={view.domain} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="text-ink">
                  <span className="text-line-2">/</span> {view.label}
                </motion.span>
              )}
            </AnimatePresence>
          </nav>
          {parts && parts.length > 1 && (
            <div className="no-scrollbar flex max-w-full gap-1 overflow-x-auto rounded-full border border-line-2 bg-card p-0.5">
              {parts.map((p) => (
                <button
                  key={p.id}
                  onClick={() => p.id !== activePart && pickPart(p.id)}
                  className={clsx("relative shrink-0 rounded-full px-2.5 py-0.5 font-mono text-[11px]", p.id === activePart ? "text-paper" : "text-ink-2 hover:text-ink")}
                >
                  {p.id === activePart && <motion.span layoutId="q-part" transition={pillSpring} className="absolute inset-0 rounded-full bg-ink" />}
                  <span className="relative">{p.label}</span>
                </button>
              ))}
            </div>
          )}
          {error && (
            <button onClick={() => setError(null)} className="chip ml-auto !border-bad text-bad" title={error}>
              failed ✕
            </button>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_280px]">
          <div ref={box} className={clsx("card relative min-w-0 overflow-hidden", pending && "cursor-progress")}>
            {graph ? (
              <AnimatePresence initial={false} mode="popLayout">
                <motion.div
                  key={view ? `${view.domain}|${view.part ?? ""}` : "all"}
                  initial={{ opacity: 0, scale: view ? 0.86 : 1.06 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: view ? 1.06 : 0.92 }}
                  transition={zoom}
                  style={{ transformOrigin: origin }}
                >
                  {view ? (
                    <QueueCanvas graph={view.graph} dots minH={360} maxH={680} onSelect={(n) => setSelected(n)} />
                  ) : (
                    <DomainMap graph={graph} onOpen={open} onPrefetch={(d) => void graphFor(d, null).catch(() => {})} />
                  )}
                </motion.div>
              </AnimatePresence>
            ) : (
              <Empty loading={!data} busy={busy} onScan={scan} />
            )}
          </div>

          <aside className="min-w-0 space-y-5 md:pt-1">
            <AnimatePresence mode="popLayout" initial={false}>
              {selected && graph && (
                <motion.div key="drawer" layout exit={{ opacity: 0, x: 8 }} className="card p-4">
                  <NodeDrawer node={selected} edges={graph.edges} risks={graph.risks} onFocus={focusRisk} onClose={() => setSelected(null)} />
                </motion.div>
              )}
            </AnimatePresence>
            {graph && (
              <motion.div layout="position">
                <div className="eyebrow mb-2">risks</div>
                <RiskList risks={graph.risks} onFocus={focusRisk} active={hover} onHover={setHover} />
              </motion.div>
            )}
          </aside>
        </div>
      </div>
    </QCtx.Provider>
  );
}

function Empty({ loading, busy, onScan }: { loading: boolean; busy: boolean; onScan: () => void }) {
  if (loading || busy)
    return (
      <div className="flex h-[360px] items-center justify-center gap-6 p-8">
        {[0, 1, 2].map((i) => (
          <div key={i} className="shimmer h-24 w-44 rounded-[18px]" />
        ))}
      </div>
    );
  return (
    <div className="flex h-[360px] flex-col items-center justify-center gap-4">
      <div className="display text-3xl">
        no scan <span className="outlined">yet</span>
      </div>
      <button className="btn btn-primary" onClick={onScan}>
        scan <span aria-hidden>→</span>
      </button>
    </div>
  );
}
