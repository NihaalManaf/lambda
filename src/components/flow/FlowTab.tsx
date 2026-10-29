"use client";

import { useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  AnimatePresence,
  MotionConfig,
  motion,
  useReducedMotion,
} from "motion/react";
import clsx from "clsx";
import Painter from "@/components/Painter";
import type { ChangeNote, FlowOp } from "@/lib/ops";
import { autoLenses, type EdgeCase, type FeatureView, type FlowLens, type FlowchartSet } from "@/lib/types";
import { notify } from "@/lib/desktop";
import FlowChart, { type ChartOp } from "./FlowChart";
import { applyGraphOp, isGraphOp } from "@/lib/flow-graph";
import { Icon, LensGlyph } from "./glyphs";
import { useEdgeCases, withoutEdgeCases } from "./edgeCases";

// Flows tab: one lens at a time (segmented control), tiny editable charts, a decision per edge case.

const LENSES: { v: FlowLens; label: string; blurb: string; cta: string }[] = [
  {
    v: "customer-journey",
    label: "customer journey",
    blurb: "screens & choices the user hits",
    cta: "draw the customer journey",
  },
  {
    v: "data",
    label: "data",
    blurb: "reads, writes, stores, third parties",
    cta: "draw the data flow",
  },
  {
    v: "infra",
    label: "infra",
    blurb: "services, queues, jobs, caches",
    cta: "draw the infra path",
  },
  {
    v: "state",
    label: "state",
    blurb: "lifecycle of the core entity",
    cta: "draw the state machine",
  },
  {
    v: "custom",
    label: "custom",
    blurb: "whatever you point it at",
    cta: "chart anything",
  },
];

const spring = { type: "spring", duration: 0.4, bounce: 0.12 } as const;

type Res = { feature: FeatureView; notes: ChangeNote[] };

const chartHas = (c: FlowchartSet["charts"][number], ref: string) =>
  c.id === ref || c.nodes.some((n) => n.id === ref) || c.edges.some((e) => e.id === ref) || c.edgeCases.some((x) => x.id === ref);

export default function FlowTab({
  feature,
  onChange,
}: {
  feature: FeatureView;
  onChange: (f: FeatureView) => void;
}) {
  const [lens, setLens] = useState<FlowLens>(
    () =>
      LENSES.find((l) => feature.flowcharts.some((s) => s.lens === l.v))?.v ??
      "customer-journey",
  );
  const [drawing, setDrawing] = useState<FlowLens[]>([]);
  const [refining, setRefining] = useState<string[]>([]);
  const [depths, setDepths] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  // latest feature for handlers fired before the next render; latest request wins
  const live = useRef(feature);
  useLayoutEffect(() => {
    live.current = feature;
  }, [feature]);
  const seq = useRef(0);
  const commit = (f: FeatureView) => {
    live.current = f;
    onChange(f);
  };

  // chat cards: {tab:'flows', ref: set | chart | node | edge | edge case id} → show that lens
  // (Workspace switches the tab, then scrolls to and pulses the chart)
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ tab?: string; ref?: string; scope?: string }>).detail;
      if (d?.tab !== "flows" || !d.ref) return;
      const sets = live.current.flowcharts;
      const set =
        sets.find((s) => !!d.scope && s.charts.some((c) => c.id === d.scope)) ??
        sets.find((s) => s.id === d.ref || s.charts.some((c) => chartHas(c, d.ref!)));
      if (set) setLens(set.lens);
    };
    window.addEventListener("lambda:focus", on);
    return () => window.removeEventListener("lambda:focus", on);
  }, []);

  const base = `/api/features/${feature.id}`;
  const post = async <T,>(
    url: string,
    body: unknown,
    method = "POST",
  ): Promise<T> => {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      // every call is scoped to the selected piece (routes read body.pieceId; item routes find the owner)
      body: JSON.stringify(body && typeof body === "object" && !Array.isArray(body) ? { pieceId: feature.pieceId || undefined, ...body } : body),
    });
    const out = await res
      .json()
      .catch(() => ({ error: `${res.status} ${res.statusText}` }));
    if (!res.ok) throw new Error(out.error ?? res.statusText);
    return out as T;
  };
  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : "failed");

  // job-driven generation (auto pipeline) + our own draws
  const flowJob = feature.jobs?.find((j) => j.kind === "flows");
  const jobBusy = flowJob?.status === "queued" || flowJob?.status === "running";
  const isDrawing = (l: FlowLens) =>
    drawing.includes(l) || (jobBusy && autoLenses(feature).includes(l));

  // ---------- edits: optimistic graph ops, reconciled with POST /ops ----------

  function edit(setId: string, chartId: string, ops: ChartOp[]): ChangeNote[] {
    const full = ops.map((o) => ({ ...o, setId, chartId }) as FlowOp);
    const prev = live.current;
    const next = structuredClone(prev);
    const notes: ChangeNote[] = [];
    try {
      for (const op of full)
        if (isGraphOp(op)) notes.push(applyGraphOp(next, op).note);
    } catch (e) {
      fail(e);
      return [];
    }
    commit(next);
    const mine = ++seq.current;
    post<Res>(`${base}/ops`, { ops: full })
      .then((r) => mine === seq.current && commit(r.feature))
      .catch((e) => {
        if (mine === seq.current) commit(prev);
        fail(e);
      })
      .finally(() => mine === seq.current && refreshDepths());
    return notes;
  }

  function toggle(
    setId: string,
    chartId: string,
    edgeCaseId: string,
    handled: EdgeCase["handled"],
  ) {
    const prev = live.current;
    const next = structuredClone(prev);
    const ec = next.flowcharts
      .find((s) => s.id === setId)
      ?.charts.find((c) => c.id === chartId)
      ?.edgeCases.find((e) => e.id === edgeCaseId);
    if (!ec) return;
    ec.handled = handled;
    commit(next);
    const mine = ++seq.current;
    post<FeatureView>(
      `${base}/flows`,
      { setId, chartId, edgeCaseId, handled },
      "PATCH",
    )
      .then((f) => mine === seq.current && commit(f))
      .catch((e) => {
        if (mine === seq.current) commit(prev);
        fail(e);
      });
  }

  async function refine(setId: string, chartId: string, instruction: string) {
    setRefining((r) => [...r, chartId]);
    try {
      const r = await post<Res>(`${base}/ops`, {
        ops: [{ op: "refine_chart", setId, chartId, instruction }],
      });
      ++seq.current;
      commit(r.feature);
      refreshDepths();
    } catch (e) {
      fail(e);
    } finally {
      setRefining((r) => r.filter((x) => x !== chartId));
    }
  }

  async function undo(setId: string, chartId: string) {
    try {
      const r = await post<Res>(`${base}/flows/undo`, { setId, chartId });
      ++seq.current;
      commit(r.feature);
    } catch (e) {
      fail(e);
    } finally {
      refreshDepths();
    }
  }

  async function draw(l: FlowLens, focus?: string) {
    if (drawing.includes(l) || (l === "custom" && !focus?.trim())) return;
    setDrawing((d) => [...d, l]);
    setError(null);
    try {
      const f = await post<FeatureView>(`${base}/flows`, {
        lens: l,
        focus: focus?.trim() || undefined,
      });
      ++seq.current;
      // keep local edits made meanwhile: only take the new set(s)
      const known = new Set(live.current.flowcharts.map((s) => s.id));
      commit({
        ...live.current,
        flowcharts: [
          ...live.current.flowcharts,
          ...f.flowcharts.filter((s) => !known.has(s.id)),
        ],
      });
      notify("flows drawn", f.title);
    } catch (e) {
      fail(e);
    } finally {
      setDrawing((d) => d.filter((x) => x !== l));
    }
  }

  function remove(setId: string) {
    const prev = live.current;
    commit({
      ...prev,
      flowcharts: prev.flowcharts.filter((s) => s.id !== setId),
    });
    const mine = ++seq.current;
    fetch(`${base}/flows?setId=${encodeURIComponent(setId)}`, {
      method: "DELETE",
    })
      .then(async (res) => {
        if (!res.ok)
          throw new Error(
            (await res.json().catch(() => ({}))).error ?? "delete failed",
          );
        if (mine === seq.current) commit(await res.json());
      })
      .catch((e) => {
        if (mine === seq.current) commit(prev);
        fail(e);
      });
  }

  // ---------- undo depth (server keeps the history) ----------

  const chartIds = feature.flowcharts
    .flatMap((s) => s.charts.map((c) => c.id))
    .join(",");
  const refreshDepths = () => {
    const ids = live.current.flowcharts.flatMap((s) =>
      s.charts.map((c) => c.id),
    );
    if (!ids.length) return;
    const q = ids.map((c) => `chart=${encodeURIComponent(c)}`).join("&");
    fetch(`${base}/flows/undo?${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (r: { depths: Record<string, number> } | null) =>
          r && setDepths(r.depths),
      )
      .catch(() => {});
  };
  const refreshRef = useRef(refreshDepths);
  useLayoutEffect(() => {
    refreshRef.current = refreshDepths;
  });
  useEffect(() => {
    refreshRef.current();
  }, [chartIds, feature.updatedAt]);

  // the pill moves now; the (heavier) canvases follow in a deferred render so the switch never drops a frame
  const shown = useDeferredValue(lens);
  const edgeCases = useEdgeCases();
  const sets = (edgeCases ? feature.flowcharts : withoutEdgeCases(feature.flowcharts)).filter((s) => s.lens === shown).reverse();
  const meta = LENSES.find((l) => l.v === shown)!;

  return (
    <MotionConfig reducedMotion="user">
      <div className="space-y-8">
        <LensBar
          lens={lens}
          onPick={setLens}
          feature={feature}
          isDrawing={isDrawing}
        />

        <AnimatePresence>
          {error && (
            <motion.button
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              className="chip !border-bad/50 text-bad"
              onClick={() => setError(null)}
            >
              {error} <Icon.close size={12} />
            </motion.button>
          )}
        </AnimatePresence>

        <motion.div
          key={shown}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
          className="space-y-10"
        >
          {sets.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="eyebrow">{meta.blurb}</span>
              <DrawMore
                lens={shown}
                busy={isDrawing(shown)}
                onDraw={(focus) => draw(shown, focus)}
              />
            </div>
          )}

          <AnimatePresence initial={false} mode="popLayout">
            {isDrawing(shown) && (
              <Drawing
                key="drawing"
                lens={shown}
                startedAt={!drawing.includes(shown) && jobBusy ? flowJob?.startedAt : undefined}
              />
            )}
            {sets.map((s) => (
              <SetView
                key={s.id}
                set={s}
                refining={refining}
                depths={depths}
                onEdit={(chartId, ops) => edit(s.id, chartId, ops)}
                onToggle={(chartId, ec, h) => toggle(s.id, chartId, ec, h)}
                onRefine={(chartId, text) => refine(s.id, chartId, text)}
                onUndo={(chartId) => undo(s.id, chartId)}
                onDelete={() => remove(s.id)}
              />
            ))}
          </AnimatePresence>

          {/* a piece split off an older feature: its flows were never drawn — one click, scoped to the piece */}
          {!isDrawing(shown) && sets.length === 0 && feature.flowcharts.length === 0 && feature.pieces.length > 1 && (
            <PieceFlowsEmpty
              key={`piece-${feature.pieceId}`}
              busy={jobBusy}
              onGenerate={() =>
                post<FeatureView>(`${base}/jobs`, { kinds: ["flows"] })
                  .then(commit)
                  .catch(fail)
              }
            />
          )}
          {!isDrawing(shown) && sets.length === 0 && !(feature.flowcharts.length === 0 && feature.pieces.length > 1) && (
            <EmptyLens
              key={shown}
              meta={meta}
              onDraw={(focus) => draw(shown, focus)}
            />
          )}
        </motion.div>
      </div>
    </MotionConfig>
  );
}

// ---------- lens switcher ----------

function LensBar({
  lens,
  onPick,
  feature,
  isDrawing,
}: {
  lens: FlowLens;
  onPick: (l: FlowLens) => void;
  feature: FeatureView;
  isDrawing: (l: FlowLens) => boolean;
}) {
  return (
    <div className="no-scrollbar -mx-1 overflow-x-auto px-1">
      <div
        role="tablist"
        aria-label="flow lens"
        className="inline-flex min-w-full gap-1 rounded-full border border-line bg-card p-1 sm:min-w-0"
      >
        {LENSES.map((l) => {
          const G = LensGlyph[l.v];
          const on = lens === l.v;
          const n = feature.flowcharts
            .filter((s) => s.lens === l.v)
            .reduce((a, s) => a + s.charts.length, 0);
          const busy = isDrawing(l.v);
          return (
            <button
              key={l.v}
              role="tab"
              aria-selected={on}
              aria-label={l.label}
              title={l.blurb}
              onClick={() => onPick(l.v)}
              className={clsx(
                "relative flex flex-1 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full px-3.5 py-2 text-[13px] font-semibold transition-colors duration-150 active:scale-[0.98] sm:flex-none",
                on
                  ? "text-paper"
                  : n || busy
                    ? "text-ink-2 hover:text-ink"
                    : "text-grey hover:text-ink",
              )}
            >
              {on && (
                <motion.span
                  layoutId="flow-lens"
                  transition={spring}
                  className="absolute inset-0 rounded-full bg-ink"
                />
              )}
              <G className="relative shrink-0" />
              <span className="relative hidden sm:inline">{l.label}</span>
              <LensState n={n} busy={busy} on={on} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LensState({ n, busy, on }: { n: number; busy: boolean; on: boolean }) {
  if (busy)
    return (
      <span
        className="relative flex size-4 items-center justify-center"
        title="drawing…"
      >
        <span className="absolute size-2 animate-ping rounded-full bg-lilac opacity-60" />
        <span className="size-1.5 rounded-full bg-lilac" />
      </span>
    );
  if (!n) return null;
  return (
    <span
      title={`${n} chart${n === 1 ? "" : "s"} drawn`}
      className={clsx(
        "relative flex h-[18px] items-center gap-0.5 rounded-full px-1.5 font-mono text-[10px] font-bold",
        on ? "bg-paper/15 text-paper" : "bg-paper-2 text-ink-2",
      )}
    >
      <Icon.check size={10} className={on ? "text-lilac" : "text-ok"} />
      {n}
    </span>
  );
}

// ---------- lens content ----------

function DrawMore({
  lens,
  busy,
  onDraw,
}: {
  lens: FlowLens;
  busy: boolean;
  onDraw: (focus?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState("");
  const need = lens === "custom";
  const go = () => {
    if (busy || (need && !focus.trim())) return;
    onDraw(focus);
    setFocus("");
    setOpen(false);
  };
  return (
    <div className="ml-auto flex items-center gap-2">
      <AnimatePresence initial={false}>
        {open && (
          <motion.input
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: 220 }}
            exit={{ opacity: 0, width: 0, transition: { duration: 0.12 } }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            autoFocus
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") go();
              if (e.key === "Escape") setOpen(false);
            }}
            placeholder={need ? "what to chart" : "focus (optional)"}
            className="input !rounded-full !py-1.5 text-[13px]"
          />
        )}
      </AnimatePresence>
      <button
        className={clsx(
          "btn !px-3.5 !py-1.5 text-[13px]",
          open ? "btn-primary" : "btn-ghost",
        )}
        disabled={busy || (open && need && !focus.trim())}
        onClick={() => (open ? go() : setOpen(true))}
      >
        {open ? (
          <>
            draw <Icon.arrow size={13} />
          </>
        ) : (
          <>
            <Icon.plus size={13} /> draw more
          </>
        )}
      </button>
    </div>
  );
}

function PieceFlowsEmpty({ busy, onGenerate }: { busy: boolean; onGenerate: () => Promise<unknown> }) {
  const reduce = useReducedMotion();
  const [sent, setSent] = useState(false);
  return (
    <motion.div
      initial={{ opacity: 0, y: reduce ? 0 : 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
      className="card mx-auto flex max-w-xl flex-col items-start gap-3 px-6 py-6 sm:flex-row sm:items-center sm:justify-between"
    >
      <div>
        <div className="text-[15px] font-semibold text-ink">no flows for this piece yet</div>
        <div className="mt-0.5 text-[13px] text-grey">drawn from this piece&apos;s stories only.</div>
      </div>
      <button
        type="button"
        disabled={busy || sent}
        onClick={() => {
          setSent(true);
          void onGenerate().finally(() => setSent(false)); // the job's own busy state takes over
        }}
        className="btn btn-primary shrink-0 justify-center"
      >
        {busy || sent ? "drawing…" : "draw this piece's flows"}
        {!(busy || sent) && <Icon.arrow size={14} />}
      </button>
    </motion.div>
  );
}

function EmptyLens({
  meta,
  onDraw,
}: {
  meta: (typeof LENSES)[number];
  onDraw: (focus?: string) => void;
}) {
  const [focus, setFocus] = useState("");
  const reduce = useReducedMotion();
  const need = meta.v === "custom";
  const G = LensGlyph[meta.v];
  const go = () => !(need && !focus.trim()) && onDraw(focus);
  return (
    <motion.div
      initial={{ opacity: 0, y: reduce ? 0 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
      className="card relative mx-auto flex max-w-3xl items-center overflow-hidden"
    >
      <div className="relative z-10 flex-1 px-6 py-10 sm:px-10">
        <div className="eyebrow flex items-center gap-2">
          <G size={13} /> {meta.blurb}
        </div>
        <h3 className="display mt-3 text-4xl sm:text-5xl">{meta.cta}</h3>
        <form
          className="mt-6 flex max-w-md flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <input
            className="input !rounded-full !py-2"
            placeholder={need ? "what to chart" : "focus (optional)"}
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            aria-label="focus"
          />
          <button
            type="submit"
            className="btn btn-primary shrink-0 justify-center"
            disabled={need && !focus.trim()}
          >
            draw <Icon.arrow size={14} />
          </button>
        </form>
      </div>
      <div className="pointer-events-none relative hidden h-64 w-52 shrink-0 self-end sm:block">
        <Image
          src="/art/sage-compass.webp"
          alt=""
          fill
          sizes="208px"
          className="fade-b object-contain object-bottom"
        />
      </div>
    </motion.div>
  );
}

function SetView({
  set,
  refining,
  depths,
  onEdit,
  onToggle,
  onRefine,
  onUndo,
  onDelete,
}: {
  set: FlowchartSet;
  refining: string[];
  depths: Record<string, number>;
  onEdit: (chartId: string, ops: ChartOp[]) => ChangeNote[];
  onToggle: (
    chartId: string,
    edgeCaseId: string,
    h: EdgeCase["handled"],
  ) => void;
  onRefine: (chartId: string, text: string) => void;
  onUndo: (chartId: string) => void;
  onDelete: () => void;
}) {
  const open = set.charts.reduce(
    (a, c) => a + c.edgeCases.filter((e) => e.handled === null).length,
    0,
  );
  return (
    <motion.section
      layout="position"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.15 } }}
      transition={spring}
      className="space-y-4"
    >
      <header className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <h2 className="display text-4xl">{set.title}</h2>
        {set.charts.length > 1 && (
          <nav className="flex gap-1 pb-1">
            {set.charts.map((c, i) => (
              <a
                key={c.id}
                href={`#chart-${c.id}`}
                title={c.title}
                className="grid size-6 place-items-center rounded-full border border-line-2 bg-card font-mono text-[11px] text-ink-2 transition-colors hover:border-ink hover:text-ink"
              >
                {i + 1}
              </a>
            ))}
          </nav>
        )}
        <div className="ml-auto flex items-center gap-2 pb-1">
          {open > 0 && (
            <span
              className="chip text-warn"
              title="edge cases still needing a call"
            >
              <span className="grid size-3.5 place-items-center rounded-full bg-warn text-[9px] font-bold text-paper">
                ?
              </span>
              {open} open
            </span>
          )}
          <button
            onClick={onDelete}
            title="delete this set"
            aria-label="delete this set"
            className="grid size-8 place-items-center rounded-full text-grey transition-colors duration-150 hover:bg-[#fbe9e6] hover:text-bad active:scale-95"
          >
            <Icon.trash />
          </button>
        </div>
      </header>

      <div className="space-y-2">
        {set.charts.map((c, i) => (
          <div key={c.id}>
            {i > 0 && (
              <div
                className="py-1 text-center font-hand text-lg text-grey"
                aria-hidden
              >
                ↓
              </div>
            )}
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...spring, delay: i * 0.05 }}
            >
              <FlowChart
                chart={c}
                index={i}
                total={set.charts.length}
                busy={refining.includes(c.id)}
                undo={depths[c.id] ?? 0}
                onOps={(ops) => onEdit(c.id, ops)}
                onToggle={(ec, h) => onToggle(c.id, ec, h)}
                onRefine={(text) => onRefine(c.id, text)}
                onUndo={() => onUndo(c.id)}
              />
            </motion.div>
          </div>
        ))}
      </div>
    </motion.section>
  );
}

function Drawing({ lens, startedAt }: { lens: FlowLens; startedAt?: string }) {
  return (
    <motion.section
      layout="position"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      transition={spring}
      className="flex justify-center py-6"
    >
      <Painter label={`drawing ${lens.replace("-", " ")}`} startedAt={startedAt} size="sm" labelAt="top" />
    </motion.section>
  );
}
