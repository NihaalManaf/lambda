"use client";
import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { LinearIssue, SessionDigest, SessionMeta, SlackMessage, SourceResult } from "@/lib/sources/types";
import { Empty, Row, Skeleton } from "./bits";
import { ago, base, useSource } from "./useSource";

// Source lists shared by /sources and the add-context sheet. `action` renders a trailing button per row.

type ListState<T> = SourceResult<T> & { loading: boolean };

function Body<T>({ s, empty, children }: { s: ListState<T>; empty: string; children: (items: T[]) => ReactNode }) {
  if (s.loading && !s.items.length) return <Skeleton />;
  if (s.error && !s.items.length) return <Empty>{s.error}</Empty>;
  if (!s.items.length) return <Empty>{empty}</Empty>;
  return <div className={s.loading ? "opacity-60 transition-opacity" : "transition-opacity"}>{children(s.items)}</div>;
}

export function useSessions(q: string) {
  return useSource<SessionMeta>("/api/sources/sessions", q);
}
export function useLinear(q: string) {
  return useSource<LinearIssue>("/api/sources/linear", q, 350);
}
export function useSlack(q: string) {
  return useSource<SlackMessage>("/api/sources/slack", q, 350);
}

export function SessionList({ s, action, expandable }: {
  s: ListState<SessionMeta>;
  action?: (m: SessionMeta) => ReactNode;
  expandable?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Body s={s} empty="no sessions match">
      {(items) =>
        items.map((m) => (
          <div key={m.id}>
            <Row
              kind="session"
              title={m.prompt}
              active={open === m.id}
              onClick={expandable ? () => setOpen(open === m.id ? null : m.id) : undefined}
              meta={
                <>
                  <span className="text-ink-2">{base(m.project)}</span>·<span>{ago(m.modified)}</span>·
                  <span>~{m.messages} msgs</span>
                </>
              }
              action={action?.(m)}
            />
            <AnimatePresence initial={false}>
              {open === m.id && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ type: "spring", stiffness: 420, damping: 38 }}
                  className="overflow-hidden"
                >
                  <Digest id={m.id} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))
      }
    </Body>
  );
}

// Last few turns of a session as a tiny chat strip.
function Digest({ id }: { id: string }) {
  const [d, setD] = useState<SessionDigest | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/sources/sessions/${id}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((j: SessionDigest) => setD({ ...j, turns: j.turns ?? [] }))
      .catch((e) => e.name !== "AbortError" && setD({ id, project: "", turns: [], excerpt: "" }));
    return () => ctrl.abort();
  }, [id]);
  if (!d) return <div className="shimmer mx-2.5 my-2 h-16 rounded-xl" />;
  return (
    <div className="mx-2.5 mb-2 ml-11 space-y-1.5 border-l-2 border-line py-1 pl-3">
      {d.turns.slice(-6).map((t, i) => (
        <div key={i} className="flex gap-2 text-[12px] leading-snug">
          <span className="w-4 shrink-0 font-mono text-grey">{t.role === "user" ? "→" : "λ"}</span>
          <span className={t.role === "user" ? "line-clamp-2 text-ink" : "line-clamp-2 text-ink-2"}>{t.text}</span>
        </div>
      ))}
      {!d.turns.length && <div className="font-mono text-[11px] text-grey">no readable turns</div>}
    </div>
  );
}

export function LinearList({ s, action }: { s: ListState<LinearIssue>; action?: (i: LinearIssue) => ReactNode }) {
  return (
    <Body s={s} empty="no issues">
      {(items) =>
        items.map((i) => (
          <Row
            key={i.id}
            kind="linear"
            title={
              <a href={i.url} target="_blank" rel="noreferrer" className="hover:underline" onClick={(e) => e.stopPropagation()}>
                {i.title}
              </a>
            }
            meta={
              <>
                <span className="text-ink-2">{i.identifier}</span>·<span>{i.state.toLowerCase()}</span>
              </>
            }
            action={action?.(i)}
          />
        ))
      }
    </Body>
  );
}

export function SlackList({ s, action }: { s: ListState<SlackMessage>; action?: (m: SlackMessage) => ReactNode }) {
  return (
    <Body s={s} empty="no messages">
      {(items) =>
        items.map((m) => (
          <Row
            key={m.id}
            kind="slack"
            title={m.text}
            meta={
              <>
                <span className="text-ink-2">{m.channel}</span>·<span>{ago(Number(m.ts) * 1000)}</span>
                {m.bots ? <span>· bot · {m.bots} posts</span> : null}
                {m.permalink && (
                  <a href={m.permalink} target="_blank" rel="noreferrer" className="hover:text-ink" onClick={(e) => e.stopPropagation()}>
                    · open ↗
                  </a>
                )}
              </>
            }
            action={action?.(m)}
          />
        ))
      }
    </Body>
  );
}
