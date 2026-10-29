"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { featureMode, type FeatureView, type IconName, type Risk, type SchemaFocus } from "@/lib/types";
import type { MigrationView, SchemaProposal } from "@/lib/schema/types";
import type { FocusView } from "@/lib/schema/focus";
import { notify } from "@/lib/desktop";
import { Icon } from "@/components/viz/icons";
import DiffLegend from "@/components/viz/DiffLegend";
import RiskList from "@/components/viz/RiskList";
import ShowSource from "@/components/viz/ShowSource";
import Sculptor from "@/components/Sculptor";
import FlagButton from "@/components/issues/FlagButton";
import Erd from "./Erd";
import ProposalComposer, { type ProposalBody } from "./ProposalComposer";

// FeatureView tab: describe a schema change (or hand over SQL / repo files) → see it drawn on the live schema.
// understand: no changes — the tables the feature uses today, at head, with what each is for.

const spring = { type: "spring", stiffness: 420, damping: 36 } as const;
const SOURCE: Record<SchemaProposal["source"], IconName> = { llm: "bolt", sql: "file", git: "split" };
type View = MigrationView & { stale: boolean };

export default function SchemaTab({ feature, onChange }: { feature: FeatureView; onChange: (f: FeatureView) => void }) {
  if (featureMode(feature) === "understand") return <CurrentSchema feature={feature} />;
  return <Proposals feature={feature} onChange={onChange} />;
}

function Proposals({ feature, onChange }: { feature: FeatureView; onChange: (f: FeatureView) => void }) {
  const [pending, setPending] = useState<ProposalBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/features/${feature.id}/schema`;
  const proposals = [...(feature.schema ?? [])].reverse();

  async function call(init: RequestInit & { url?: string }) {
    const res = await fetch(init.url ?? base, { headers: { "content-type": "application/json" }, ...init });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    return body as FeatureView;
  }

  async function send(b: ProposalBody) {
    if (pending) return;
    setPending(b);
    setError(null);
    try {
      const f = await call({ method: "POST", body: JSON.stringify({ ...b, pieceId: feature.pieceId || undefined }) });
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
        {pending && <Drafting key="pending" />}
        {proposals.map((p) => (
          <ProposalCard key={p.id} featureId={feature.id} pieceId={feature.pieceId} p={p} onDelete={() => remove(p.id)} />
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

function ProposalCard({ featureId, pieceId, p, onDelete }: { featureId: string; pieceId: string; p: SchemaProposal; onDelete: () => void }) {
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
  const openTable = useCallback((id: string) => router.push(schemaHref(id, featureId, pieceId)), [router, featureId, pieceId]);
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

function Drafting() {
  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={spring}
      className="flex justify-center py-8"
    >
      <Sculptor label="drafting the schema" size="sm" />
    </motion.section>
  );
}

type Focus = FocusView & { focus: SchemaFocus };

// the schema page, with this feature's ask bar
const schemaHref = (table: string, fid: string, pid: string) =>
  `/schema?table=${encodeURIComponent(table)}&feature=${encodeURIComponent(fid)}${pid ? `&piece=${encodeURIComponent(pid)}` : ""}`;

function CurrentSchema({ feature }: { feature: FeatureView }) {
  const router = useRouter();
  const url = `/api/features/${feature.id}/schema/current?piece=${encodeURIComponent(feature.pieceId)}`;
  const [state, setState] = useState<{ url: string; v: Focus | null; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const v = state?.url === url ? state.v : null;
  const failed = state?.url === url ? state.error : undefined;

  const load = useCallback(
    async (method: "GET" | "POST") => {
      const r = await fetch(url, { method });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error ?? r.statusText);
      return b as Focus;
    },
    [url],
  );
  useEffect(() => {
    let live = true;
    load("GET")
      .then((b) => live && setState({ url, v: b }))
      .catch((e) => live && setState({ url, v: null, error: e instanceof Error ? e.message : "failed" }));
    return () => {
      live = false;
    };
  }, [load, url]);
  async function repick() {
    setBusy(true);
    try {
      setState({ url, v: await load("POST") });
    } catch (e) {
      setState({ url, v, error: e instanceof Error ? e.message : "failed" });
    } finally {
      setBusy(false);
    }
  }
  const openTable = useCallback((id: string) => router.push(schemaHref(id, feature.id, feature.pieceId)), [router, feature.id, feature.pieceId]);

  if (!v)
    return failed ? (
      <div className="flex flex-col items-center py-16 text-center">
        <div className="display text-3xl">
          no <span className="outlined">schema</span>
        </div>
        <p className="mt-2 text-[13px] text-grey">{failed} · check the migrations folder in settings</p>
      </div>
    ) : (
      <div className="flex justify-center py-8">
        <Sculptor label="finding its tables" size="sm" />
      </div>
    );

  const tables = v.focus.tables.filter((t) => v.history[t.id]);
  return (
    <section className="card overflow-hidden">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3">
        <h3 className="display min-w-0 flex-1 truncate text-2xl">tables it uses today</h3>
        {v.stale && (
          <span className="chip !border-warn/60 text-warn" title="migrations changed since these were picked">
            <Icon name="clock" size={11} /> stale
          </span>
        )}
        <button type="button" onClick={repick} disabled={busy} className="chip transition-transform duration-150 active:scale-[0.97] disabled:opacity-50">
          {busy ? "picking…" : "re-pick"}
        </button>
      </header>
      {tables.length ? (
        <div className="flex flex-col md:flex-row">
          <div className="relative min-w-0 flex-1">
            <Erd graph={v.graph} hover={hover} onHover={setHover} onOpenTable={openTable} />
          </div>
          <aside className="flex w-full min-w-0 flex-col gap-4 border-t border-line p-4 md:w-80 md:shrink-0 md:border-l md:border-t-0">
            {tables.map((t) => (
              <div key={t.id} onMouseEnter={() => setHover(t.id)} onMouseLeave={() => setHover(null)}>
                <div className="flex items-center justify-between gap-2">
                  <button type="button" onClick={() => openTable(t.id)} className="font-mono text-[12.5px] text-ink hover:underline">
                    {t.id.replace(/^public\./, "")}
                  </button>
                  <FlagButton refTo={{ tab: "schema", id: t.id, label: t.id.replace(/^public\./, "") }} title={`table ${t.id.replace(/^public\./, "")}`} detail={t.role || undefined} label="" />
                </div>
                {t.role && <p className="mt-0.5 text-[13px] leading-snug text-ink-2">{t.role}</p>}
                {v.history[t.id].length > 0 && (
                  <p className="mt-1 font-mono text-[10.5px] leading-relaxed text-grey" title={v.history[t.id].map((m) => m.id).join("\n")}>
                    {v.history[t.id]
                      .slice(0, 3)
                      .map((m) => `${m.date} ${m.title}`)
                      .join(" · ")}
                    {v.history[t.id].length > 3 ? ` · +${v.history[t.id].length - 3}` : ""}
                  </p>
                )}
              </div>
            ))}
          </aside>
        </div>
      ) : (
        <p className="px-5 py-10 text-center text-[13px] text-grey">no tables matched this feature · re-pick, or ask the chat which tables it touches</p>
      )}
    </section>
  );
}
