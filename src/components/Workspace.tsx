"use client";

import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { Feature, FeatureView, Job, JobKind, Piece } from "@/lib/types";
import { findPiece, firstPiece, isView, mergePieceView, pieceView, sortPieces } from "@/lib/pieces";
import AskBar from "@/components/askbar/AskBar";
import IntakeView from "@/components/intake/IntakeView";
import BriefTab from "./brief/BriefTab";
import ContextTab from "./context/ContextTab";
import FlowTab from "./flow/FlowTab";
import { appDown } from "./mockup/api";
import MockupTab from "./mockup/MockupTab";
import { pieceAction } from "./pieces/api";
import PieceRail from "./pieces/PieceRail";
import QueuesTab from "./queues/QueuesTab";
import SchemaTab from "./schema/SchemaTab";
import StoriesTab from "./stories/StoriesTab";
import VerifyTab from "./verify/VerifyTab";

type TabProps = { feature: FeatureView; onChange: (f: FeatureView) => void };
type TabDef = { key: string; label: string; job: JobKind | null; scope: "piece" | "feature"; n: (f: FeatureView) => number; C: React.ComponentType<TabProps> };

// piece tabs (left) are about the selected PR; brief · context (right, after a divider) are the feature's
const TABS = [
  { key: "stories", label: "stories", job: "stories", scope: "piece", n: (f) => f.stories.length, C: StoriesTab },
  { key: "flows", label: "flows", job: "flows", scope: "piece", n: (f) => f.flowcharts.reduce((a, s) => a + s.charts.length, 0), C: FlowTab },
  { key: "schema", label: "schema", job: "schema", scope: "piece", n: (f) => f.schema?.length ?? 0, C: SchemaTab },
  { key: "queues", label: "queues", job: "queues", scope: "piece", n: (f) => f.queues?.length ?? 0, C: QueuesTab },
  { key: "sketch", label: "ui sketch", job: "sketch", scope: "piece", n: (f) => f.mockups.length, C: MockupTab },
  { key: "verify", label: "verify", job: null, scope: "piece", n: (f) => f.runs.length, C: VerifyTab },
  { key: "brief", label: "brief", job: null, scope: "feature", n: () => 0, C: BriefTab },
  { key: "context", label: "context", job: "context", scope: "feature", n: (f) => f.context.length, C: ContextTab },
] as const satisfies readonly TabDef[];

type TabKey = (typeof TABS)[number]["key"];
type Tab = (typeof TABS)[number];
const TAB_KEYS = TABS.map((t) => t.key) as string[];

// schema + queues are per-piece visualizers: only when the piece needs them (or already has proposals)
const shown = (f: FeatureView, k: TabKey) =>
  k === "schema" ? !!f.needs?.schema || !!f.schema?.length : k === "queues" ? !!f.needs?.queues || !!f.queues?.length : true;

// fields each job writes; a finished job's fields are the only ones a poll may replace
const OWNS: Record<JobKind, (keyof FeatureView)[]> = {
  intake: ["chat", "intake", "briefDoc", "brief"],
  pieces: ["pieces"],
  context: ["context", "discovery"],
  stories: ["stories"],
  flows: ["flowcharts"],
  schema: ["schema"],
  queues: ["queues"],
  needs: ["needs", "flowcharts"],
  sketch: ["mockups"],
};

// a flow ref may be a set, chart, node, edge or edge case id → the chart card that holds it
function flowSelector(f: FeatureView, ref: string): string | null {
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
const jobOf = (f: FeatureView, k: JobKind) => f.jobs?.find((j) => j.kind === k);
const POLL_MS = 1500;
const UNDO_MS = 6000;
const ease = [0.23, 1, 0.32, 1] as const;
const isEmpty = (f: FeatureView) => !f.stories.length && !f.flowcharts.length && !f.jobs?.some((j) => j.kind !== "context");
const anyLive = (f: Feature) => (f.jobs ?? []).some(active) || f.pieces.some((p) => (p.jobs ?? []).some(active));

// "<piece id or ''>:<kind>" → finishedAt of a done job (finished jobs are what a poll may merge)
function doneMap(f: Feature): Map<string, string | undefined> {
  const m = new Map<string, string | undefined>();
  for (const j of f.jobs ?? []) m.set(`:${j.kind}`, j.status === "done" ? j.finishedAt : undefined);
  for (const p of f.pieces ?? []) for (const j of p.jobs ?? []) m.set(`${p.id}:${j.kind}`, j.status === "done" ? j.finishedAt : undefined);
  return m;
}

// Holds the stored Feature. Tabs get a projection of the selected piece (?piece=, default first) and their
// changes (views, or views straight from the api) are merged back with mergePieceView. While the feature
// is in its intake conversation, the IntakeView owns the screen; the workspace fades in once it settles.
export default function Workspace({ initial }: { initial: Feature }) {
  const [stored, setStored] = useState(initial);
  const intake = stored.phase === "intake";
  const reduce = useReducedMotion();

  return (
    // the intake page is long and the hand-off button sits at its bottom: start the workspace at its header
    <AnimatePresence mode="wait" initial={false} onExitComplete={() => window.scrollTo({ top: 0 })}>
      {intake ? (
        <motion.div
          key="intake"
          exit={{ opacity: 0, filter: reduce ? "none" : "blur(4px)", transition: { duration: 0.22, ease } }}
        >
          <IntakeView feature={stored} onChange={(f: Feature | FeatureView) => setStored((cur) => absorbWhole(cur, f))} />
        </motion.div>
      ) : (
        <motion.div
          key="workspace"
          initial={{ opacity: 0, filter: reduce ? "none" : "blur(4px)", transform: reduce ? "none" : "translateY(8px)" }}
          // transform / filter on an ancestor would trap position:fixed children (ask bar, dialogs): clear them after
          animate={{ opacity: 1, filter: "blur(0px)", transform: "translateY(0px)", transitionEnd: { filter: "none", transform: "none" } }}
          transition={{ duration: 0.38, ease }}
        >
          <Shaped stored={stored} setStored={setStored} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// A whole Feature, or a view of one of its pieces (tabs, routes, intake), merged into ours. A view carries the
// server's `pieces`, which win for every other piece; its own artifacts land in its piece.
function absorbWhole(cur: Feature, f: Feature | FeatureView): Feature {
  return isView(f) ? mergePieceView(cur, f.pieceId, f) : mergePieceView(cur, "", f);
}

function Shaped({ stored, setStored }: { stored: Feature; setStored: React.Dispatch<React.SetStateAction<Feature>> }) {
  const reduce = useReducedMotion();
  const params = useSearchParams();
  const asked = params.get("piece");
  const selectedId = findPiece(stored, asked)?.id ?? firstPiece(stored)?.id ?? "";
  // the rail moves this frame; the piece's board / tabs render as interruptible background work, so
  // switching to a heavy piece never blocks the rail's layout animation (everything below follows pieceId)
  const pieceId = useDeferredValue(selectedId);
  const piece = stored.pieces.find((p) => p.id === pieceId);
  const pieces = useMemo(() => sortPieces(stored.pieces), [stored.pieces]);
  const feature = useMemo(() => pieceView(stored, pieceId), [stored, pieceId]);

  const pid = useRef(pieceId);
  useEffect(() => {
    pid.current = pieceId;
  }, [pieceId]);

  const setFeature = useCallback(
    (next: Feature | FeatureView | ((v: FeatureView) => FeatureView)) =>
      setStored((cur) => {
        const v = typeof next === "function" ? next(pieceView(cur, pid.current)) : next;
        return absorbWhole(cur, v);
      }),
    [setStored],
  );

  const selectPiece = useCallback((id: string) => {
    const u = new URL(window.location.href);
    u.searchParams.set("piece", id);
    window.history.replaceState(null, "", u.pathname + u.search + u.hash);
  }, []);

  // ---------- tabs ----------

  const [tab, setTab] = useState<TabKey>("stories");
  // visited piece tabs stay mounted for the current piece only; switching piece starts them fresh
  const [visited, setVisited] = useState<{ piece: string; keys: TabKey[] }>({ piece: pieceId, keys: ["stories"] });
  if (visited.piece !== pieceId) setVisited({ piece: pieceId, keys: [tab] });
  const [flash, setFlash] = useState<string[]>([]); // `${pieceId}:${kind}` that just finished: tiny ✓

  const tabs = useMemo(() => TABS.filter((t) => shown(feature, t.key)), [feature]);
  const pieceTabs = tabs.filter((t) => t.scope === "piece");
  const featureTabs = tabs.filter((t) => t.scope === "feature");
  const tabKeys = useRef<TabKey[]>(tabs.map((t) => t.key));
  useEffect(() => {
    tabKeys.current = tabs.map((t) => t.key);
  }, [tabs]);
  // a tab that vanished (schema on a piece without it) falls back to stories
  const current: TabKey = tabs.some((t) => t.key === tab) ? tab : "stories";

  const open = useCallback((k: TabKey) => {
    setTab(k); // underline + selection move this frame
    // mounting a heavy tab (react flow, sketch canvas) is interruptible work, not a frame drop
    startTransition(() => setVisited((v) => (v.keys.includes(k) ? v : { ...v, keys: [...v.keys, k] })));
  }, []);

  // ---------- lambda:focus {tab, ref, piece?} (ask bar change cards, "run in browser") ----------
  // switch piece (if given) + tab; stories scrolls itself, everything else is found by data-focus-id / chart anchor
  const live = useRef(feature);
  const piecesRef = useRef(stored.pieces);
  useEffect(() => {
    live.current = feature;
    piecesRef.current = stored.pieces;
  }, [feature, stored.pieces]);
  useEffect(() => {
    let timer = 0;
    let hop = 0;
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ tab?: string; ref?: string; scope?: string; piece?: string }>).detail;
      if (!d?.tab) return;
      if (d.piece && d.piece !== pid.current && piecesRef.current.some((p) => p.id === d.piece)) {
        selectPiece(d.piece);
        // let the piece's tabs mount, then focus again without the hop
        window.clearTimeout(hop);
        hop = window.setTimeout(() => window.dispatchEvent(new CustomEvent("lambda:focus", { detail: { ...d, piece: undefined } })), 80);
        return;
      }
      const smooth = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
      if (d.tab === "overview") return window.scrollTo({ top: 0, behavior: smooth });
      if (!TAB_KEYS.includes(d.tab)) return;
      const k = d.tab as TabKey;
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
      window.clearTimeout(hop);
    };
  }, [open, selectPiece]);

  const onFocus = useCallback((tab: string, ref?: string, piece?: string, note?: { scope?: string }) => {
    window.dispatchEvent(new CustomEvent("lambda:focus", { detail: { tab, ref, piece, scope: note?.scope } }));
  }, []);

  // ---------- background jobs: poll + merge ----------

  const seen = useRef(doneMap(stored)); // last server job snapshot

  const absorb = useCallback(
    (server: FeatureView) => {
      const before = seen.current;
      const after = doneMap(server);
      seen.current = after;
      const sp = server.pieceId;
      const finished = [...after].filter(([k, at]) => at && before.get(k) !== at).map(([k]) => k);
      // only the polled piece's own + feature-level finished jobs replace local fields; other pieces are the server's
      const mine = finished.filter((k) => k.startsWith(":") || k.startsWith(`${sp}:`)).map((k) => k.split(":")[1] as JobKind);
      setStored((cur) => {
        if (!sp || !cur.pieces.some((p) => p.id === sp)) return mergePieceView(cur, sp, server); // a piece we haven't seen yet: the server's
        const local = pieceView(cur, sp);
        const next: FeatureView = {
          ...local,
          pieces: server.pieces,
          phase: server.phase,
          status: server.status,
          jobs: server.jobs,
          needs: server.needs,
          discovery: server.discovery,
          briefDoc: server.briefDoc,
          intake: server.intake,
        };
        for (const k of mine) for (const field of OWNS[k]) (next as unknown as Record<string, unknown>)[field] = server[field];
        return mergePieceView(cur, sp, next);
      });
      if (finished.length) {
        const keys = finished.map((k) => (k.startsWith(":") ? `${sp}${k}` : k));
        setFlash((x) => [...new Set([...x, ...keys])]);
        window.setTimeout(() => setFlash((x) => x.filter((k) => !keys.includes(k))), 1800);
      }
    },
    [setStored],
  );

  const polling = anyLive(stored) || stored.phase === "shaping";
  useEffect(() => {
    if (!polling) return;
    let stop = false;
    let t = 0;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const q = pid.current ? `?piece=${encodeURIComponent(pid.current)}` : "";
          const res = await fetch(`/api/features/${stored.id}/jobs${q}`, { cache: "no-store" });
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
  }, [polling, stored.id, absorb]);

  const [starting, setStarting] = useState(false);
  const run = useCallback(
    async (kinds?: JobKind[]) => {
      setStarting(true);
      // optimistic: dots + tabs appear before the round trip
      setFeature((f) => {
        const ks: JobKind[] = kinds ?? ["context", "stories", "flows", "needs", "sketch"];
        const jobs = [...(f.jobs ?? []).filter((j) => !ks.includes(j.kind)), ...ks.map((kind): Job => ({ kind, status: "queued" }))];
        const needs =
          kinds?.includes("schema") || kinds?.includes("queues")
            ? { schema: !!f.needs?.schema || !!kinds?.includes("schema"), queues: !!f.needs?.queues || !!kinds?.includes("queues"), why: f.needs?.why ?? "added by hand" }
            : f.needs;
        return { ...f, jobs, needs };
      });
      if (kinds?.length === 1 && (kinds[0] === "schema" || kinds[0] === "queues")) open(kinds[0]);
      try {
        const res = await fetch(`/api/features/${stored.id}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...(kinds ? { kinds } : {}), pieceId: pid.current || undefined }),
        });
        if (res.ok) absorb(await res.json());
      } finally {
        setStarting(false);
      }
    },
    [stored.id, absorb, open, setFeature],
  );

  // ---------- piece management ----------

  const [pieceErr, setPieceErr] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ piece: Piece; index: number; at: number } | null>(null);

  const act = useCallback(
    async (a: Parameters<typeof pieceAction>[1], optimistic?: (f: Feature) => Feature) => {
      setPieceErr(null);
      const before = stored;
      if (optimistic) setStored(optimistic);
      try {
        const r = await pieceAction(stored.id, a, pid.current);
        setStored((cur) => absorbWhole(cur, r.feature));
        return r;
      } catch (e) {
        if (optimistic) setStored(before);
        setPieceErr((e as Error).message);
        return null;
      }
    },
    [stored, setStored],
  );

  const addPiece = async (title: string) => {
    const r = await act({ action: "add", title });
    if (r) selectPiece(r.feature.pieceId);
  };
  const renamePiece = (id: string, title: string) =>
    void act({ action: "rename", pieceId: id, title }, (f) => ({ ...f, pieces: f.pieces.map((p) => (p.id === id ? { ...p, title } : p)) }));
  const reorderPieces = (ids: string[]) =>
    void act({ action: "reorder", ids }, (f) => ({ ...f, pieces: f.pieces.map((p) => ({ ...p, order: ids.indexOf(p.id) + 1 || p.order })) }));
  const removePiece = async (id: string) => {
    const idx = pieces.findIndex((p) => p.id === id);
    const neighbour = pieces[idx - 1] ?? pieces[idx + 1];
    if (id === pieceId && neighbour) selectPiece(neighbour.id);
    const r = await act({ action: "remove", pieceId: id }, (f) => ({ ...f, pieces: f.pieces.filter((p) => p.id !== id) }));
    if (r?.removed) setUndo({ ...r.removed, at: Date.now() });
  };
  const restorePiece = async () => {
    if (!undo) return;
    setUndo(null);
    const r = await act({ action: "restore", piece: undo.piece, index: undo.index });
    if (r) selectPiece(r.feature.pieceId);
  };

  // ---------- idle warm-up ----------

  // warm the other tabs of this piece while the page is idle, one per idle slice, so the first click is instant
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
              const k = tabKeys.current.find((key) => !v.keys.includes(key));
              return k ? { ...v, keys: [...v.keys, k] } : v;
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
  }, [pieceId]);

  // "app not running" is the sketch tab's own calm card, not an alarm up here
  const failed = (feature.jobs ?? []).filter((j) => j.status === "error" && !(j.kind === "sketch" && appDown(j)));
  const ghosts = (["schema", "queues"] as const).filter((k) => !shown(feature, k));
  const multi = pieces.length > 1;
  const shaping = stored.phase === "shaping";

  const tabButton = (t: Tab) => {
    const j = t.job ? jobOf(feature, t.job) : undefined;
    const on = current === t.key;
    return (
      <motion.button
        key={t.key}
        layout={reduce ? false : "position"}
        transition={{ type: "spring", stiffness: 500, damping: 40 }}
        role="tab"
        aria-selected={on}
        aria-busy={active(j) || undefined}
        onClick={() => open(t.key)}
        className={`relative flex shrink-0 items-center whitespace-nowrap px-3 pb-3 pt-2 text-sm transition-colors md:px-4 ${on ? "text-ink" : "text-grey hover:text-ink-2"}`}
      >
        {t.label}
        {t.n(feature) > 0 && <span className="ml-1.5 font-mono text-[11px] text-grey">{t.n(feature)}</span>}
        <TabSignal job={j} flash={!!t.job && flash.includes(`${pieceId}:${t.job}`)} reduce={!!reduce} />
        {on && (
          <motion.span
            layoutId="tab-underline"
            className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-ink"
            transition={{ type: "spring", stiffness: 500, damping: 40 }}
          />
        )}
      </motion.button>
    );
  };

  return (
    <main className="mx-auto min-w-0 max-w-7xl px-4 pb-32 pt-8 md:px-6 md:pt-10">
      <div className="mb-3 flex items-center gap-3">
        <span className="eyebrow flex items-center gap-2">
          {shaping && (
            <span className="relative grid h-2.5 w-2.5 place-items-center" aria-hidden>
              <span className="absolute h-2.5 w-2.5 animate-ping rounded-full bg-lilac/70 [animation-duration:1.6s]" />
              <span className="relative h-1.5 w-1.5 rounded-full bg-lilac" />
            </span>
          )}
          {/* phase, not the lifecycle status: "shaping" only while pieces are still generating */}
          {shaping && <span>shaping ·</span>}
          <span className={shaping ? "text-grey/70" : undefined}>{pieces.length === 1 ? "1 pr" : `${pieces.length} prs`}</span>
        </span>
      </div>
      <h1 className="display break-words text-4xl md:text-6xl">{feature.title}</h1>
      <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-2">{feature.brief}</p>

      {multi && (
        <PieceRail
          pieces={stored.pieces}
          selected={selectedId}
          onSelect={selectPiece}
          onRename={renamePiece}
          onReorder={reorderPieces}
          onRemove={(id) => void removePiece(id)}
          onAdd={(t) => void addPiece(t)}
        />
      )}
      <AnimatePresence initial={false} mode="popLayout">
        {multi && piece?.why && (
          <motion.p
            key={piece.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={{ duration: 0.18 }}
            className="mt-3 max-w-2xl text-[13px] text-grey"
          >
            {piece.why}
          </motion.p>
        )}
      </AnimatePresence>

      {/* one obvious action for an empty piece; errors as retry chips */}
      <AnimatePresence initial={false}>
        {(isEmpty(feature) || failed.length > 0 || pieceErr) && (
          <motion.div
            initial={{ opacity: 0, transform: reduce ? "none" : "translateY(-4px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ duration: 0.2, ease }}
            className="mt-6 flex flex-wrap items-center gap-2"
          >
            {isEmpty(feature) && (
              <button className="btn btn-primary" disabled={starting} onClick={() => run()}>
                <span aria-hidden>✦</span> {multi ? "generate this piece" : "generate everything"}
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
            {pieceErr && (
              <button onClick={() => setPieceErr(null)} className="chip !border-bad/40 text-bad" title="dismiss">
                {pieceErr} ✕
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className="no-scrollbar -mx-4 mt-8 flex items-center gap-1 overflow-x-auto whitespace-nowrap border-b border-line px-4 md:mx-0 md:mt-10 md:px-0"
        role="tablist"
      >
        {pieceTabs.map(tabButton)}
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
        <span className="ml-auto mr-1 h-4 w-px shrink-0 bg-line pl-px" aria-hidden />
        {featureTabs.map(tabButton)}
      </div>

      {/* visited tabs stay mounted (inert + hidden) so in-flight model work keeps its state; piece tabs per piece */}
      <div className="relative pt-8">
        {tabs
          .filter((t) => visited.keys.includes(t.key) || t.key === current)
          .map((t) => {
            const on = t.key === current;
            return (
              <motion.section
                key={t.scope === "piece" ? `${t.key}:${pieceId}` : t.key}
                inert={!on}
                aria-hidden={!on}
                initial={{ opacity: 0, y: reduce ? 0 : 6 }}
                animate={on ? { opacity: 1, y: 0 } : { opacity: 0, y: 0 }}
                transition={{ duration: on ? 0.22 : 0, ease }}
                className={on ? "relative" : "pointer-events-none invisible absolute inset-x-0 top-8 h-0 overflow-hidden"}
              >
                <t.C feature={feature} onChange={setFeature} />
              </motion.section>
            );
          })}
      </div>

      <PieceUndo undo={undo} onUndo={() => void restorePiece()} onDismiss={() => setUndo(null)} />
      <AskBar feature={feature} pieceId={pieceId} onChange={setFeature} onFocus={onFocus} />
    </main>
  );
}

// sits above the ask bar
function PieceUndo({ undo, onUndo, onDismiss }: { undo: { piece: Piece; at: number } | null; onUndo: () => void; onDismiss: () => void }) {
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(onDismiss, Math.max(0, undo.at + UNDO_MS - Date.now()));
    return () => clearTimeout(t);
  }, [undo, onDismiss]);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4">
      <AnimatePresence>
        {undo && (
          <motion.div
            key={undo.at}
            role="status"
            initial={{ opacity: 0, transform: "translateY(16px) scale(0.97)" }}
            animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
            exit={{ opacity: 0, transform: "translateY(8px) scale(1)", transition: { duration: 0.15 } }}
            transition={{ type: "spring", duration: 0.35, bounce: 0.15 }}
            className="pointer-events-auto relative flex items-center gap-3 overflow-hidden rounded-full bg-ink py-2 pl-4 pr-2 text-[13px] text-paper shadow-[0_18px_40px_-16px_rgba(24,24,24,.6)]"
          >
            <span className="font-mono text-[11px] text-paper/60">−</span>
            <span className="max-w-[46vw] truncate">piece · {undo.piece.title}</span>
            <button
              onClick={onUndo}
              className="rounded-full bg-paper/10 px-3 py-1 text-xs font-semibold transition-[background-color,transform] duration-150 hover:bg-paper/20 active:scale-[0.97]"
            >
              undo
            </button>
            <motion.span
              className="absolute bottom-0 left-0 h-[2px] w-full origin-left bg-lilac"
              initial={{ scaleX: 1 }}
              animate={{ scaleX: 0 }}
              transition={{ duration: UNDO_MS / 1000, ease: "linear" }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
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
