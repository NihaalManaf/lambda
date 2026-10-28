"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import type { Feature, Story, StoryStatus } from "@/lib/types";
import type { Run } from "@/lib/runs";
import type { MaskedAccount } from "@/components/settings/types";
import { asA } from "@/components/stories/bits";
import RunPanel, { isActive, StatusPill } from "./RunPanel";
import { runsChanged } from "@/lib/desktop";

const STORY_DOT: Record<StoryStatus, string> = { todo: "bg-line-2", building: "bg-blue", passing: "bg-ok", failing: "bg-bad" };
const spring = { type: "spring", stiffness: 380, damping: 32 } as const;

const ago = (iso: string, now: number) => {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

export default function VerifyTab({ feature, onChange }: { feature: Feature; onChange: (f: Feature) => void }) {
  const runs = feature.runs as Run[];
  const [accounts, setAccounts] = useState<MaskedAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mountedAt] = useState(() => Date.now());

  // "run in browser" (stories) / chat cards: {tab:'verify', ref: runId} → select that run
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ tab?: string; ref?: string }>).detail;
      if (d?.tab === "verify" && d.ref) setPicked(d.ref);
    };
    window.addEventListener("lambda:focus", on);
    return () => window.removeEventListener("lambda:focus", on);
  }, []);

  const activeId = picked ?? runs.find((r) => isActive(r.status))?.id ?? runs[0]?.id ?? null;
  const run = runs.find((r) => r.id === activeId);
  // every active run is polled, not just the one on screen
  const polling = runs.filter((r) => isActive(r.status)).map((r) => r.id).join(",");

  const latest = useRef(feature);
  useEffect(() => {
    latest.current = feature;
  });

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s: { accounts: MaskedAccount[] }) => {
        setAccounts(s.accounts ?? []);
        setAccountId((cur) => cur || s.accounts?.[0]?.id || "");
      })
      .catch(() => {});
  }, []);

  // Poll live runs every 1s; when one finishes pull the feature so story statuses update.
  useEffect(() => {
    if (!polling) return;
    const ids = polling.split(",");
    const fid = latest.current.id;
    let stop = false;
    const tick = async () => {
      const got = await Promise.all(
        ids.map((rid) =>
          fetch(`/api/runs/${rid}?feature=${fid}`)
            .then((x) => (x.ok ? (x.json() as Promise<Run>) : null))
            .catch(() => null),
        ),
      );
      if (stop) return;
      const fresh = got.filter((r): r is Run => !!r);
      if (fresh.some((r) => !isActive(r.status))) {
        const f = await fetch(`/api/features/${fid}`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
        if (!stop && f) return onChange(f as Feature);
      }
      const cur = latest.current;
      if (!stop && fresh.length)
        onChange({ ...cur, runs: cur.runs.map((x) => fresh.find((r) => r.id === x.id) ?? x) });
    };
    const i = setInterval(tick, 1000);
    return () => {
      stop = true;
      clearInterval(i);
    };
  }, [polling, onChange]);

  async function start(story: Story) {
    setStarting(story.id);
    setErr(null);
    try {
      const res = await fetch(`/api/features/${feature.id}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ storyId: story.id, accountId: accountId || undefined }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "could not start");
      onChange(body.feature);
      setPicked(body.runId);
      runsChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setStarting(null);
    }
  }

  async function cancel(runId: string) {
    await fetch(`/api/runs/${runId}/cancel`, { method: "POST" }).catch(() => {});
    runsChanged();
  }

  if (!feature.stories.length) return <Empty />;

  const storyBusy = (sid: string) => runs.some((r) => r.storyId === sid && isActive(r.status));

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      {/* stories */}
      <div className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <span className="eyebrow">log in as</span>
          {accounts.length ? (
            <div className="flex flex-wrap gap-1.5">
              {[{ id: "", label: "anonymous" }, ...accounts].map((a) => (
                <button
                  key={a.id || "anon"}
                  onClick={() => setAccountId(a.id)}
                  className={clsx(
                    "chip transition-colors",
                    accountId === a.id ? "border-ink bg-ink text-paper" : "text-ink-2 hover:border-ink",
                  )}
                >
                  {a.label || "untitled"}
                </button>
              ))}
            </div>
          ) : (
            <a href="/settings" className="chip text-grey hover:text-ink">
              no test accounts · add one →
            </a>
          )}
        </div>

        <AnimatePresence>
          {err && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mb-3 font-hand text-[16px] text-marker"
            >
              ✗ {err}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="space-y-2.5">
          {feature.stories.map((s, i) => {
            const busy = storyBusy(s.id);
            const last = runs.find((r) => r.storyId === s.id);
            return (
              <motion.div
                key={s.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...spring, delay: Math.min(i, 8) * 0.03 }}
                className={clsx("card flex items-center gap-4 px-4 py-3.5 transition-shadow", last?.id === activeId && "ring-2 ring-lilac")}
              >
                <span className={clsx("h-2.5 w-2.5 shrink-0 rounded-full", STORY_DOT[s.status])} title={s.status} />
                <button className="min-w-0 flex-1 text-left" onClick={() => last && setPicked(last.id)}>
                  <div className="eyebrow truncate">
                    {s.priority} · {asA(s.role)} {s.role}
                  </div>
                  <div className="mt-0.5 truncate text-[14px] font-semibold">{s.want}</div>
                  <div className="mt-1 font-mono text-[11px] text-grey">
                    {s.acceptance.length} check{s.acceptance.length === 1 ? "" : "s"} · {s.status}
                  </div>
                </button>
                <button
                  className={clsx("btn shrink-0 !px-3.5 !py-1.5 !text-[13px]", busy ? "btn-ghost" : "btn-primary")}
                  disabled={busy || starting === s.id || !s.acceptance.length}
                  onClick={() => start(s)}
                  title={s.acceptance.length ? "run in browser" : "no acceptance criteria"}
                >
                  {starting === s.id ? <span className="shimmer h-3 w-12 rounded" /> : busy ? "running…" : "run ▸"}
                </button>
              </motion.div>
            );
          })}
        </div>

        {runs.length > 0 && (
          <div className="mt-10">
            <div className="eyebrow mb-3">history</div>
            <div className="divide-y divide-line overflow-hidden rounded-[18px] border border-line bg-card">
              {runs.map((r) => {
                const st = feature.stories.find((s) => s.id === r.storyId);
                return (
                  <motion.button
                    key={r.id}
                    data-focus-id={r.id}
                    layout="position"
                    transition={spring}
                    onClick={() => setPicked(r.id)}
                    className={clsx(
                      "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-paper",
                      r.id === activeId && "bg-lilac-soft/60",
                    )}
                  >
                    <StatusPill status={r.status} />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{r.summary ?? st?.want ?? "deleted story"}</span>
                    <span className="shrink-0 font-mono text-[11px] text-grey">{ago(r.startedAt, mountedAt)}</span>
                  </motion.button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* live run */}
      <div className="min-w-0 lg:sticky lg:top-20 lg:self-start">
        <AnimatePresence mode="wait">
          {run ? (
            <motion.div
              key={run.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              <RunPanel run={run} story={feature.stories.find((s) => s.id === run.storyId)} onCancel={() => cancel(run.id)} />
            </motion.div>
          ) : (
            <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="card flex flex-col items-center px-8 py-12 text-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/art/sage-compass.webp" alt="" className="fade-b h-44 w-auto object-contain" />
              <div className="display mt-4 text-3xl">pick a story, hit run</div>
              <div className="mt-2 text-[13px] text-grey">claude drives a real browser through every check</div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="card flex flex-col items-center px-8 py-16 text-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/art/athena-circuit.webp" alt="" className="fade-b h-52 w-auto object-contain" />
      <div className="display mt-6 text-4xl">
        nothing to <span className="italic">verify</span> yet
      </div>
      <div className="mt-2 text-[14px] text-grey">write stories first — each acceptance check becomes a browser test</div>
    </div>
  );
}
