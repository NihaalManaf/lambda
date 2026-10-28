"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import type { Risk } from "@/lib/types";
import type { ErdGraph, MigrationView, SchemaHead } from "@/lib/schema/types";
import { Icon } from "@/components/viz/icons";
import RiskList from "@/components/viz/RiskList";
import DiffLegend from "@/components/viz/DiffLegend";
import Erd from "./Erd";
import MigrationRail from "./MigrationRail";
import Scrubber from "./Scrubber";
import TablePicker from "./TablePicker";

// /schema: scrubber on top, ERD of the selected migration, rail on the right.
// Handle at the end (= now) swaps the ERD for the table picker; a picked table shows its head view + history.

const CANVAS_H = 580;
const enc = encodeURIComponent;
const getJson = async <T,>(url: string): Promise<T> => {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body as T;
};

type TableView = { id: string; graph: ErdGraph; history: string[] };

const syncUrl = (k: "m" | "table", v: string | null) => {
  const u = new URL(window.location.href);
  u.searchParams.delete("m");
  u.searchParams.delete("table");
  if (v) u.searchParams.set(k, v);
  history.replaceState(history.state, "", u);
};

export default function SchemaExplorer({
  head,
  initialTable,
  initialMigration,
}: {
  head: SchemaHead;
  initialTable?: string;
  initialMigration?: string;
}) {
  const migs = head.migrations;
  const n = migs.length;
  const [idx, setIdx] = useState(() => {
    const i = initialMigration ? migs.findIndex((m) => m.id === initialMigration) : -1;
    return i < 0 ? n : i;
  });
  const [filter, setFilter] = useState("");
  const [table, setTable] = useState<string | null>(initialTable ?? null);
  const [views, setViews] = useState<Record<string, MigrationView>>({});
  const [shown, setShown] = useState<MigrationView | null>(null);
  const [tview, setTview] = useState<TableView | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mid = idx < n ? migs[idx].id : null;
  const isHead = mid === null;

  // migration view: debounced while scrubbing, cached, neighbours prefetched
  useEffect(() => {
    if (!mid) return;
    let live = true;
    const show = (v: MigrationView) => live && setShown(v);
    const fetchView = (id: string) =>
      getJson<MigrationView>(`/api/schema/migrations/${enc(id)}`).then((v) => {
        setViews((c) => (c[id] ? c : { ...c, [id]: v }));
        return v;
      });
    const cached = views[mid];
    if (cached) {
      const t = window.setTimeout(() => show(cached), 0);
      return () => {
        live = false;
        window.clearTimeout(t);
      };
    }
    const t = window.setTimeout(() => {
      fetchView(mid)
        .then((v) => {
          show(v);
          // neighbours both ways, so a drag lands on views already in hand
          for (const j of [idx + 1, idx - 1, idx + 2, idx - 2, idx + 3, idx - 3])
            if (j >= 0 && j < n && !views[migs[j].id]) fetchView(migs[j].id).catch(() => {});
        })
        .catch((e) => live && setError(e instanceof Error ? e.message : "failed"));
    }, 40);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [mid, idx, n, migs, views]);

  // table head view
  useEffect(() => {
    if (!table) return;
    let live = true;
    getJson<{ graph: ErdGraph; history: string[] }>(`/api/schema/tables/${enc(table)}`)
      .then((v) => live && setTview({ id: table, ...v }))
      .catch((e) => live && setError(e instanceof Error ? e.message : "failed"));
    return () => {
      live = false;
    };
  }, [table]);

  const scrub = (i: number) => {
    setIdx(i);
    syncUrl(i < n ? "m" : "table", i < n ? migs[i].id : table);
  };
  const openTable = useCallback(
    (id: string) => {
      setTable(id);
      setIdx(n);
      syncUrl("table", id);
    },
    [n],
  );
  const closeTable = () => {
    setTable(null);
    setTview(null);
    syncUrl("table", null);
  };

  const tv = table && tview?.id === table ? tview : null;
  const highlight = useMemo(() => (tv ? new Set(tv.history) : null), [tv]);
  const graph = isHead ? (tview?.graph ?? null) : (shown?.graph ?? null);
  const mode = isHead && !table ? "picker" : "erd";
  // while scrubbing the rail keeps the last view, dimmed, instead of flashing a skeleton
  const view = !isHead ? shown : null;
  const dim = !!view && view.meta.id !== mid;
  const loadSql = useCallback(
    () => (mid ? getJson<MigrationView>(`/api/schema/migrations/${enc(mid)}?sql=1`).then((v) => v.sql ?? "") : Promise.resolve("")),
    [mid],
  );
  const focus = (r: Risk) => setHover((h) => (h === r.id ? null : r.id));

  return (
    <div className="space-y-4">
      <Scrubber migrations={migs} index={idx} onChange={scrub} filter={filter} onFilter={setFilter} highlight={highlight} />

      <AnimatePresence>
        {error && (
          <motion.button
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="chip !border-bad text-bad"
            onClick={() => setError(null)}
          >
            {error} ✕
          </motion.button>
        )}
      </AnimatePresence>

      <div className="card flex flex-col overflow-hidden md:flex-row">
        <div className="relative min-w-0 flex-1" style={{ height: CANVAS_H }}>
          <AnimatePresence mode="wait" initial={false}>
            {mode === "picker" ? (
              <motion.div
                key="picker"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="absolute inset-0 overflow-y-auto"
              >
                <TablePicker tables={head.tables} filter={filter} onPick={openTable} />
              </motion.div>
            ) : (
              <motion.div
                key="erd"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="absolute inset-0"
              >
                {graph ? (
                  <Erd graph={graph} height={CANVAS_H} hover={hover} onHover={setHover} onOpenTable={openTable} />
                ) : (
                  <div className="grid h-full place-items-center">
                    <div className="shimmer h-40 w-64 rounded-2xl" />
                  </div>
                )}
                <DiffLegend className="pointer-events-none absolute bottom-3 left-4 rounded-full bg-paper/80 px-2 py-1 backdrop-blur-sm" />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <aside className="w-full min-w-0 border-t border-line md:w-[280px] md:shrink-0 md:overflow-y-auto md:max-h-[580px] md:border-l md:border-t-0">
          {!isHead ? (
            <div className={clsx("h-full transition-opacity duration-150", dim && "opacity-40")}>
              <MigrationRail view={view} hover={hover} onHover={setHover} onFocus={focus} loadSql={loadSql} />
            </div>
          ) : table ? (
            <TableRail id={table} view={tv} hover={hover} onHover={setHover} onFocus={focus} onClose={closeTable} />
          ) : (
            <HeadRail head={head} />
          )}
        </aside>
      </div>
    </div>
  );
}

function TableRail({
  id,
  view,
  hover,
  onHover,
  onFocus,
  onClose,
}: {
  id: string;
  view: TableView | null;
  hover: string | null;
  onHover: (id: string | null) => void;
  onFocus: (r: Risk) => void;
  onClose: () => void;
}) {
  const t = view?.graph.tables.find((x) => x.id === id);
  return (
    <motion.div
      key={id}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="flex flex-col gap-4 p-4"
    >
      <div className="flex items-start gap-2">
        <h2 className="display min-w-0 flex-1 break-words text-[28px] leading-[1.05]">{id.replace(/^public\./, "")}</h2>
        <button
          type="button"
          onClick={onClose}
          title="all tables"
          className="mt-1 grid size-6 place-items-center rounded-full border border-line-2 text-[11px] text-grey transition-colors hover:border-ink hover:text-ink"
        >
          ✕
        </button>
      </div>
      {view ? (
        <>
          <div className="flex flex-wrap gap-3 font-mono text-[11px] text-ink-2">
            {t && <Stat icon="index" v={t.cols.length} title="columns" />}
            <Stat icon="link" v={view.graph.edges.length} title="links" />
            <Stat icon="clock" v={view.history.length} title="migrations" />
            {t?.rls && <Stat icon="lock" v="rls" title="row security" />}
            {t?.origin === "stub" && <span className="rounded-full border border-dashed border-line-2 px-1.5 text-grey">partial</span>}
          </div>
          <div>
            <div className="eyebrow mb-1.5">risks</div>
            <RiskList risks={view.graph.risks} onFocus={onFocus} active={hover} onHover={onHover} />
          </div>
        </>
      ) : (
        <div className="shimmer h-5 w-2/3 rounded-md" />
      )}
    </motion.div>
  );
}

function HeadRail({ head }: { head: SchemaHead }) {
  const { stats } = head;
  return (
    <div className="flex flex-col gap-5 p-4">
      <h2 className="display text-[28px]">now</h2>
      <div className="grid grid-cols-2 gap-3">
        <Big v={stats.tables} label="tables" />
        <Big v={stats.files} label="migrations" />
      </div>
      {stats.parseErrors > 0 && (
        <span className="chip w-fit !border-bad text-bad" title="migrations that did not parse">
          <Icon name="warn" size={12} /> {stats.parseErrors} unparsed
        </span>
      )}
      {!head.baseline && (
        <div className="flex items-center gap-1.5 text-[12px] text-grey" title="set a pg_dump baseline in settings">
          <span className="size-2.5 rounded-[3px] border border-dashed border-ink-2" /> dashed = partial
        </div>
      )}
    </div>
  );
}

const Big = ({ v, label }: { v: number | string; label: string }) => (
  <div>
    <div className="font-serif text-3xl leading-none">
      {v}
    </div>
    <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-grey">{label}</div>
  </div>
);

const Stat = ({ icon, v, title }: { icon: Parameters<typeof Icon>[0]["name"]; v: number | string; title: string }) => (
  <span title={title} className="inline-flex items-center gap-1">
    <Icon name={icon} size={12} className="text-grey" />
    {v}
  </span>
);
