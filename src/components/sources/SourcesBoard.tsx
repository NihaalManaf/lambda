"use client";
import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
import type { CliTool } from "@/lib/sources/types";
import { SearchInput, Skeleton, StatusDot } from "./bits";
import { LinearList, SessionList, SlackList, useLinear, useSessions, useSlack } from "./lists";
import { useSource } from "./useSource";

// /sources: four editorial panels. Each = number, name, status, search, compact rows.

function Panel({ n, name, status, search, children, i }: {
  n: string;
  name: string;
  status: ReactNode;
  search?: ReactNode;
  children: ReactNode;
  i: number;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 30, delay: i * 0.05 }}
      className="card flex min-h-[420px] flex-col p-5"
    >
      <header className="mb-4 flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-xs text-grey">{n}</span>
          <h2 className="display text-3xl">{name}</h2>
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-grey">{status}</div>
      </header>
      {search && <div className="mb-3">{search}</div>}
      <div className="-mx-2 max-h-[380px] flex-1 overflow-y-auto overscroll-contain px-2">{children}</div>
    </motion.section>
  );
}

function Status({ loading, error, connected, label }: { loading: boolean; error?: string; connected: boolean; label?: string }) {
  const ok = connected && !error;
  return (
    <>
      <StatusDot ok={ok} loading={loading} />
      <span>{loading ? "…" : !connected ? "not connected" : error ? "error" : (label ?? "live")}</span>
    </>
  );
}

function CliGrid({ s }: { s: { items: CliTool[]; loading: boolean } }) {
  if (s.loading && !s.items.length) return <Skeleton rows={3} />;
  const tools = [...s.items].sort((a, b) => Number(b.installed) - Number(a.installed));
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {tools.map((t, i) => (
        <motion.div
          key={t.name}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: i * 0.015, type: "spring", stiffness: 400, damping: 30 }}
          title={t.path}
          className={`flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[12px] ${
            t.installed ? "border-line-2 bg-card text-ink" : "border-dashed border-line text-grey/70"
          }`}
        >
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.installed ? "bg-ok" : "bg-line-2"}`} />
          <span className="truncate">{t.name}</span>
          {t.version && <span className="ml-auto truncate text-[10px] text-grey">{t.version}</span>}
        </motion.div>
      ))}
    </div>
  );
}

export default function SourcesBoard() {
  const [sq, setSq] = useState("");
  const [lq, setLq] = useState("");
  const [kq, setKq] = useState("");
  const sessions = useSessions(sq);
  const linear = useLinear(lq);
  const slack = useSlack(kq);
  const cli = useSource<CliTool>("/api/sources/cli", "");
  const installed = cli.items.filter((t) => t.installed).length;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-2 [&>*]:min-w-0">
      <Panel
        i={0}
        n="01"
        name="past sessions"
        status={<Status {...sessions} label={`${sessions.items.length} recent`} />}
        search={<SearchInput value={sq} onChange={setSq} placeholder="search prompts, projects" />}
      >
        <SessionList s={sessions} expandable />
      </Panel>
      <Panel
        i={1}
        n="02"
        name="linear"
        status={<Status {...linear} label={linear.via === "assigned" ? "my issues" : (linear.via ?? "live")} />}
        search={<SearchInput value={lq} onChange={setLq} placeholder="search issues" />}
      >
        <LinearList s={linear} />
      </Panel>
      <Panel
        i={2}
        n="03"
        name="slack"
        status={<Status {...slack} label={slack.via === "search" ? "search" : "bot channels"} />}
        search={<SearchInput value={kq} onChange={setKq} placeholder="search messages" />}
      >
        <SlackList s={slack} />
      </Panel>
      <Panel
        i={3}
        n="04"
        name="cli tools"
        status={<Status {...cli} label={`${installed}/${cli.items.length} found`} />}
      >
        <CliGrid s={cli} />
      </Panel>
    </div>
  );
}
