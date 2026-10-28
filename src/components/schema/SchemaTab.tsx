"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import type { Feature, IconName, Risk } from "@/lib/types";
import type { MigrationView, SchemaProposal } from "@/lib/schema/types";
import { notify } from "@/lib/desktop";
import { Icon } from "@/components/viz/icons";
import DiffLegend from "@/components/viz/DiffLegend";
import RiskList from "@/components/viz/RiskList";
import ShowSource from "@/components/viz/ShowSource";
import Erd from "./Erd";
import ProposalComposer, { type ProposalBody } from "./ProposalComposer";

// Feature tab: describe a schema change (or hand over SQL / repo files) → see it drawn on the live schema.

const spring = { type: "spring", stiffness: 420, damping: 36 } as const;
const SOURCE: Record<SchemaProposal["source"], IconName> = { llm: "bolt", sql: "file", git: "split" };
type View = MigrationView & { stale: boolean };

export default function SchemaTab({ feature, onChange }: { feature: Feature; onChange: (f: Feature) => void }) {
  const [pending, setPending] = useState<ProposalBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/features/${feature.id}/schema`;
  const proposals = [...(feature.schema ?? [])].reverse();

  async function call(init: RequestInit & { url?: string }) {
    const res = await fetch(init.url ?? base, { headers: { "content-type": "application/json" }, ...init });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    return body as Feature;
  }

  async function send(b: ProposalBody) {
    if (pending) return;
    setPending(b);
    setError(null);
    try {
      const f = await call({ method: "POST", body: JSON.stringify(b) });
      onChange(f);
      notify("schema drawn", f.schema?.at(-1)?.title ?? f.title);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setPending(null);
    }
  }

  async function remove(pid: string) {
    const prev = feature;
    onChange({ ...feature, schema: (feature.schema ?? []).filter((p) => p.id !== pid) });
    try {
      onChange(await call({ method: "DELETE", url: `${base}?pid=${encodeURIComponent(pid)}` }));
    } catch (e) {
      onChange(prev);
      setError(e instanceof Error ? e.message : "failed");
    }
  }

  return (
    <div className="space-y-8">
      <ProposalComposer busy={!!pending} onSend={send} />

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

      <AnimatePresence initial={false} mode="popLayout">
        {pending && <Skeleton key="pending" body={pending} />}
        {proposals.map((p) => (
          <ProposalCard key={p.id} featureId={feature.id} p={p} onDelete={() => remove(p.id)} />
        ))}
      </AnimatePresence>

      {!pending && proposals.length === 0 && (
        <div className="flex flex-col items-center py-16 text-center">
          <div className="display text-3xl">
            no schema <span className="outlined">changes</span>
          </div>
          <p className="mt-2 text-[13px] text-grey">describe · paste sql · or pick from repo</p>
        </div>
      )}
    </div>
  );
}

function ProposalCard({ featureId, p, onDelete }: { featureId: string; p: SchemaProposal; onDelete: () => void }) {
  const router = useRouter();
  const [view, setView] = useState<{ key: string; v: View | null; error?: string } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const url = `/api/features/${featureId}/schema/${encodeURIComponent(p.id)}`;
  const key = `${p.id}:${p.baseSig}:${p.ops.length}`;
  const v = view?.key === key ? view.v : null;
  const failed = view?.key === key ? view.error : undefined;

  useEffect(() => {
    let live = true;
    fetch(url)
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.error ?? r.statusText);
        if (live) setView({ key, v: b as View });
      })
      .catch((e) => live && setView({ key, v: null, error: e instanceof Error ? e.message : "failed" }));
    return () => {
      live = false;
    };
  }, [url, key]);

  const loadSql = useCallback(async () => {
    if (p.sql) return p.sql;
    const r = await fetch(`${url}?sql=1`);
    const b = (await r.json()) as Partial<View>;
    return b.sql ?? "";
  }, [p.sql, url]);
  const openTable = useCallback((id: string) => router.push(`/schema?table=${encodeURIComponent(id)}`), [router]);
  const focus = (r: Risk) => setHover((h) => (h === r.id ? null : r.id));

  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={spring}
      className="card overflow-hidden"
    >
      <header className="flex items-center gap-3 border-b border-line px-5 py-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-lilac-soft text-ink" title={p.source}>
          <Icon name={SOURCE[p.source]} size={14} />
        </span>
        <h3 className="display min-w-0 flex-1 truncate text-2xl">{p.title}</h3>
        {v?.stale && (
          <span className="chip !border-warn/60 text-warn" title="schema moved since this was drawn">
            <Icon name="clock" size={11} /> stale
          </span>
        )}
        <button
          onClick={onDelete}
          className="grid size-7 place-items-center rounded-full border border-line-2 text-[11px] text-grey transition-colors hover:border-ink hover:text-ink"
          title="delete"
        >
          ✕
        </button>
      </header>

      <div className="flex flex-col md:flex-row">
        <div className="relative min-w-0 flex-1">
          {v ? (
            <Erd graph={v.graph} hover={hover} onHover={setHover} onOpenTable={openTable} />
          ) : (
            <div className="grid h-72 place-items-center bg-paper">
              {failed ? <span className="font-hand text-lg text-bad">{failed}</span> : <div className="shimmer h-40 w-64 rounded-2xl" />}
            </div>
          )}
          <DiffLegend className="pointer-events-none absolute bottom-3 left-4 rounded-full bg-paper/80 px-2 py-1 backdrop-blur-sm" />
        </div>
        <aside className="flex w-full min-w-0 flex-col gap-3 border-t border-line p-4 md:w-72 md:shrink-0 md:border-l md:border-t-0">
          <div className="eyebrow">risks</div>
          {v ? (
            <RiskList risks={v.graph.risks} onFocus={focus} active={hover} onHover={setHover} />
          ) : (
            <div className="shimmer h-5 rounded-md" />
          )}
          <ShowSource load={loadSql} lang="sql" className="mt-auto pt-2" />
        </aside>
      </div>
    </motion.section>
  );
}

function Skeleton({ body }: { body: ProposalBody }) {
  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={spring}
      className="card overflow-hidden"
    >
      <div className="flex items-center gap-3 border-b border-line px-5 py-3">
        <span className="grid size-7 place-items-center rounded-full bg-lilac-soft">
          <Icon name={SOURCE[body.source]} size={14} />
        </span>
        <div className="shimmer h-6 w-56 rounded-lg" />
      </div>
      <div className="flex">
        <div className="flex flex-1 items-center justify-center gap-16 bg-paper py-10">
          {[0, 1].map((i) => (
            <div key={i} className="w-48 overflow-hidden rounded-xl border border-line">
              <div className="shimmer h-8" />
              {[0, 1, 2, 3].map((j) => (
                <div key={j} className="mx-3 my-2 h-3 rounded-full bg-paper-2" />
              ))}
            </div>
          ))}
        </div>
        <div className="hidden w-72 space-y-3 border-l border-line p-4 md:block">
          {[0, 1, 2].map((j) => (
            <div key={j} className="shimmer h-5 rounded-md" />
          ))}
        </div>
      </div>
    </motion.section>
  );
}
