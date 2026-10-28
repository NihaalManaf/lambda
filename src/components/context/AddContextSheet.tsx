"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import type { ContextRef } from "@/lib/types";
import type { SessionDigest } from "@/lib/sources/types";
import { AddButton, KindIcon, SearchInput } from "../sources/bits";
import { LinearList, SessionList, SlackList, useLinear, useSessions, useSlack } from "../sources/lists";
import { base } from "../sources/useSource";

// md+ → right drawer; phones → bottom sheet
const MQ = "(min-width: 768px)";
const subscribe = (cb: () => void) => {
  const m = window.matchMedia(MQ);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
const useWide = () => useSyncExternalStore(subscribe, () => window.matchMedia(MQ).matches, () => true);

// Right-hand sheet: pick a source, search, "+" to attach. Attach is optimistic (parent handles it).

export type Draft = Omit<ContextRef, "id"> & { key: string }; // key = source-side id, for dedupe

const TABS = [
  { key: "session", label: "sessions" },
  { key: "linear", label: "linear" },
  { key: "slack", label: "slack" },
  { key: "note", label: "note" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export default function AddContextSheet({ open, onClose, onAdd, attached }: {
  open: boolean;
  onClose: () => void;
  onAdd: (d: Draft, enrich?: () => Promise<Partial<Draft>>) => void;
  attached: Attached; // source keys (or same kind + url/title) already attached
}) {
  const [tab, setTab] = useState<Tab>("session");
  const wide = useWide();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="scrim"
            className="fixed inset-0 z-50 bg-ink/15"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />
          <motion.aside
            key="sheet"
            role="dialog"
            aria-label="add context"
            // bottom sheet on phones, right drawer from md
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] h-[85dvh] w-full flex-col rounded-t-[28px] border-t border-line bg-paper shadow-[0_-24px_60px_-30px_rgba(24,24,24,0.35)] md:inset-x-auto md:inset-y-0 md:right-0 md:h-auto md:max-h-none md:max-w-[460px] md:rounded-none md:border-l md:border-t-0 md:shadow-[-24px_0_60px_-30px_rgba(24,24,24,0.35)]"
            initial={wide ? { x: "100%" } : { y: "100%" }}
            animate={{ x: 0, y: 0 }}
            exit={wide ? { x: "100%" } : { y: "100%" }}
            transition={{ type: "spring", duration: 0.42, bounce: 0 }}
          >
            <header className="flex items-start justify-between px-6 pb-4 pt-6">
              <div>
                <div className="eyebrow mb-1">manual search · pinned on add</div>
                <h2 className="display text-3xl">add context</h2>
              </div>
              <button onClick={onClose} aria-label="close" className="btn btn-ghost !h-8 !w-8 !justify-center !p-0 text-grey hover:text-ink">
                ×
              </button>
            </header>

            <div className="mx-6 flex gap-1 rounded-full bg-paper-2 p-1">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={clsx(
                    "relative flex-1 rounded-full px-3 py-1.5 text-[13px] transition-colors",
                    tab === t.key ? "text-ink" : "text-grey hover:text-ink-2",
                  )}
                >
                  {tab === t.key && (
                    <motion.span
                      layoutId="ctx-tab"
                      className="absolute inset-0 rounded-full bg-card shadow-sm"
                      transition={{ type: "spring", stiffness: 500, damping: 40 }}
                    />
                  )}
                  <span className="relative flex items-center justify-center gap-1.5">
                    <KindIcon kind={t.key} size={16} />
                    {t.label}
                  </span>
                </button>
              ))}
            </div>

            <div className="mt-4 flex-1 overflow-hidden">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={tab}
                  initial={{ opacity: 0, x: 6 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -6, transition: { duration: 0.1 } }}
                  transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                  className="flex h-full flex-col"
                >
                  {tab === "session" && <Sessions onAdd={onAdd} attached={attached} />}
                  {tab === "linear" && <Linear onAdd={onAdd} attached={attached} />}
                  {tab === "slack" && <Slack onAdd={onAdd} attached={attached} />}
                  {tab === "note" && <Note onAdd={onAdd} />}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

type Attached = { has: (key: string, d?: { kind: Draft["kind"]; title: string; url?: string }) => boolean };
type PaneProps = { onAdd: Parameters<typeof AddContextSheet>[0]["onAdd"]; attached: Attached };

function Pane({ search, children }: { search: React.ReactNode; children: React.ReactNode }) {
  return (
    <>
      <div className="px-6 pb-3">{search}</div>
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-8">{children}</div>
    </>
  );
}

function Sessions({ onAdd, attached }: PaneProps) {
  const [q, setQ] = useState("");
  const s = useSessions(q);
  return (
    <Pane search={<SearchInput autoFocus value={q} onChange={setQ} placeholder="search past sessions" />}>
      <SessionList
        s={s}
        action={(m) => (
          <AddButton
            done={attached.has(`session:${m.id}`, { kind: "session", title: `${base(m.project)} · ${m.prompt}`.slice(0, 140) })}
            onClick={() =>
              onAdd(
                { key: `session:${m.id}`, kind: "session", title: `${base(m.project)} · ${m.prompt}`.slice(0, 140), excerpt: m.prompt },
                async () => {
                  const d = (await fetch(`/api/sources/sessions/${m.id}`).then((r) => r.json())) as SessionDigest;
                  return d.excerpt ? { excerpt: d.excerpt } : {};
                },
              )
            }
          />
        )}
      />
    </Pane>
  );
}

function Linear({ onAdd, attached }: PaneProps) {
  const [q, setQ] = useState("");
  const s = useLinear(q);
  return (
    <Pane search={<SearchInput autoFocus value={q} onChange={setQ} placeholder="search linear issues" />}>
      {s.via === "recent" && !q && <div className="eyebrow px-2.5 pb-2">nothing assigned · recent open</div>}
      <LinearList
        s={s}
        action={(i) => (
          <AddButton
            done={attached.has(`linear:${i.identifier}`, { kind: "linear", title: `${i.identifier} ${i.title}`, url: i.url })}
            onClick={() =>
              onAdd({
                key: `linear:${i.identifier}`,
                kind: "linear",
                title: `${i.identifier} ${i.title}`,
                excerpt: [i.state, i.description].filter(Boolean).join(" · "),
                url: i.url,
              })
            }
          />
        )}
      />
    </Pane>
  );
}

function Slack({ onAdd, attached }: PaneProps) {
  const [q, setQ] = useState("");
  const s = useSlack(q);
  return (
    <Pane search={<SearchInput autoFocus value={q} onChange={setQ} placeholder="search slack" />}>
      <SlackList
        s={s}
        action={(m) => (
          <AddButton
            done={attached.has(`slack:${m.id}`, { kind: "slack", title: `${m.channel} · ${m.text}`.slice(0, 80), url: m.permalink })}
            onClick={() =>
              onAdd({
                key: `slack:${m.id}`,
                kind: "slack",
                title: `${m.channel} · ${m.text}`.slice(0, 80),
                excerpt: m.text,
                url: m.permalink,
              })
            }
          />
        )}
      />
    </Pane>
  );
}

function Note({ onAdd }: { onAdd: PaneProps["onAdd"] }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sent, setSent] = useState(0);
  const ok = title.trim().length > 0;
  const submit = () => {
    if (!ok) return;
    onAdd({ key: `note:${Date.now()}`, kind: "note", title: title.trim(), excerpt: body.trim() });
    setTitle("");
    setBody("");
    setSent((n) => n + 1);
  };
  return (
    <form
      className="flex flex-col gap-3 px-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input className="input" autoFocus value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} placeholder="title — e.g. pricing must stay hidden" />
      <div className="relative">
        <textarea
          className="input min-h-[120px] resize-none leading-relaxed"
          value={body}
          maxLength={400}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && submit()}
          placeholder="the one thing the agent must know"
        />
        <span className={clsx("absolute bottom-2 right-3 font-mono text-[10px]", body.length > 360 ? "text-warn" : "text-grey")}>
          {body.length}/400
        </span>
      </div>
      <div className="flex items-center justify-between">
        <AnimatePresence>
          {sent > 0 && (
            <motion.span key={sent} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="font-mono text-[11px] text-ok">
              ✓ attached
            </motion.span>
          )}
        </AnimatePresence>
        <button type="submit" disabled={!ok} className="btn btn-primary ml-auto">
          attach note
        </button>
      </div>
    </form>
  );
}
