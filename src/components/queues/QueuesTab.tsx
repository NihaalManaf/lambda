"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { FeatureView, Risk } from "@/lib/types";
import type { QueueGraph, QueueProposal } from "@/lib/queues/types";
import { notify } from "@/lib/desktop";
import { Icon } from "@/components/viz/icons";
import DiffLegend from "@/components/viz/DiffLegend";
import RiskList from "@/components/viz/RiskList";
import ShowSource from "@/components/viz/ShowSource";
import Sculptor from "@/components/Sculptor";
import QueueCanvas from "./QueueCanvas";
import QueueComposer from "./QueueComposer";
import { QCtx } from "./qNodes";

// FeatureView tab: propose a queue change (prompt or repo diff), see it as a diff over the touched domains.

const spring = { type: "spring", stiffness: 420, damping: 36 } as const;

export default function QueuesTab({ feature, onChange }: { feature: FeatureView; onChange: (f: FeatureView) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/features/${feature.id}/queues`;
  const proposals = [...(feature.queues ?? [])].reverse();

  async function call(init: RequestInit & { url?: string }) {
    const res = await fetch(init.url ?? base, { headers: { "content-type": "application/json" }, ...init });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    return body as FeatureView;
  }

  async function propose(body: { source: "llm"; prompt: string } | { source: "git" }) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const f = await call({ method: "POST", body: JSON.stringify({ ...body, pieceId: feature.pieceId || undefined }) });
      onChange(f);
      notify("queue change drawn", f.title);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  // optimistic delete: drop locally, reconcile, roll back on failure
  async function remove(pid: string) {
    const prev = feature;
    onChange({ ...feature, queues: (feature.queues ?? []).filter((p) => p.id !== pid) });
    try {
      onChange(await call({ method: "DELETE", url: `${base}?pid=${encodeURIComponent(pid)}` }));
    } catch (e) {
      onChange(prev);
      setError(e instanceof Error ? e.message : "failed");
    }
  }

  return (
    <div className="space-y-10">
      <QueueComposer busy={busy} onPrompt={(prompt) => propose({ source: "llm", prompt })} onGit={() => propose({ source: "git" })} />

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
        {busy && <Mapping key="mapping" />}
        {proposals.map((p) => (
          <ProposalCard key={p.id} fid={feature.id} proposal={p} onDelete={() => remove(p.id)} />
        ))}
      </AnimatePresence>

      {!busy && proposals.length === 0 && (
        <div className="flex flex-col items-center py-16 text-center">
          <div className="display text-3xl">
            no queue changes <span className="outlined">yet</span>
          </div>
        </div>
      )}
    </div>
  );
}

type Drawn = QueueGraph & { stale?: boolean };

function ProposalCard({ fid, proposal, onDelete }: { fid: string; proposal: QueueProposal; onDelete: () => void }) {
  const [state, setState] = useState<{ graph?: Drawn; error?: string }>({});
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const url = `/api/features/${fid}/queues/${encodeURIComponent(proposal.id)}`;

  useEffect(() => {
    let live = true;
    fetch(url)
      .then((r) => (r.ok ? (r.json() as Promise<Drawn>) : Promise.reject(new Error(r.statusText))))
      .then(
        (graph) => live && setState({ graph }),
        (e: Error) => live && setState({ error: e.message }),
      );
    return () => {
      live = false;
    };
  }, [url]);

  const graph = state.graph;
  // git proposals: the changed snippets, stitched from the node endpoint
  const loadSource = useCallback(async () => {
    const changed = (graph?.nodes ?? []).filter((n) => n.ref && n.diff !== "same" && n.diff !== "context");
    const parts = await Promise.all(
      changed.map(async (n) => {
        const r = await fetch(`/api/queues/nodes/${encodeURIComponent(n.id)}`);
        const b = r.ok ? ((await r.json()) as { snippet?: string }) : {};
        return `// ${n.ref!.file}:${n.ref!.line}\n${b.snippet ?? ""}`;
      }),
    );
    return parts.join("\n\n") || (proposal.files ?? []).join("\n");
  }, [graph, proposal.files]);

  function focusRisk(r: Risk) {
    setHover(r.id);
    const t = r.target;
    setSelected(t.kind === "edge" ? (graph?.edges.find((e) => e.id === t.id)?.to ?? null) : t.id);
  }

  return (
    <motion.section layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }} transition={spring}>
      <div className="card overflow-hidden">
        <header className="flex items-center gap-3 border-b border-line px-5 py-3">
          <span className="text-grey" title={proposal.source === "git" ? "from repo diff" : "described"}>
            <Icon name={proposal.source === "git" ? "split" : "bolt"} size={15} />
          </span>
          <h3 className="display min-w-0 flex-1 truncate text-2xl">{proposal.title}</h3>
          {graph?.stale && (
            <span className="chip text-warn" title="topology changed since">
              <Icon name="warn" size={11} /> stale
            </span>
          )}
          <button
            onClick={onDelete}
            className="grid size-7 shrink-0 place-items-center rounded-full border border-line-2 text-[11px] text-grey transition-colors hover:border-ink hover:text-ink"
            title="delete"
          >
            ✕
          </button>
        </header>

        <QCtx.Provider value={{ hover, setHover, selected, focus: null }}>
          <div className="flex flex-col md:flex-row">
            <div className="min-w-0 flex-1">
              {graph ? (
                <QueueCanvas graph={graph} dots onSelect={(n) => setSelected((s) => (s === n.id ? null : n.id))} />
              ) : state.error ? (
                <div className="grid h-[260px] place-items-center text-[13px] text-bad">
                  <span className="inline-flex items-center gap-1.5">
                    <Icon name="warn" size={14} /> failed
                  </span>
                </div>
              ) : (
                <div className="shimmer h-[260px]" />
              )}
            </div>
            <aside className="w-full min-w-0 space-y-4 border-t border-line p-4 md:w-[280px] md:flex-none md:border-l md:border-t-0">
              <DiffLegend />
              {graph && <RiskList risks={graph.risks} onFocus={focusRisk} active={hover} onHover={setHover} />}
              {proposal.source === "git" && graph && <ShowSource load={loadSource} lang="code" />}
            </aside>
          </div>
        </QCtx.Provider>
      </div>
    </motion.section>
  );
}

function Mapping() {
  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={spring}
      className="flex justify-center py-8"
    >
      <Sculptor label="mapping the queues" size="sm" />
    </motion.section>
  );
}
