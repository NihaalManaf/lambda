"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { FeatureView, Issue, IssueKind } from "@/lib/types";
import { addIssue, buildIssues, patchIssue, removeIssue } from "./api";

// Understand mode: what to fix or extend, collected while reading the feature (chat, the session, flags on
// stories / flows / sketches / tables, failed runs, or by hand). Pick some → a new build feature starts from
// them; they stay here as "in build", linked.

const KINDS: IssueKind[] = ["bug", "improvement", "question"];
const KIND_TONE: Record<IssueKind, string> = { bug: "bg-bad", improvement: "bg-lilac", question: "bg-warn" };
const SOURCE: Record<Issue["source"], string> = { chat: "chat", intake: "session", manual: "", pin: "flagged", verify: "verify", check: "code check" };
const spring = { type: "spring", stiffness: 420, damping: 34 } as const;

export default function IssuesTab({ feature, onChange }: { feature: FeatureView; onChange: (f: FeatureView) => void }) {
  const router = useRouter();
  const reduce = useReducedMotion();
  const all = feature.issues ?? [];
  const open = all.filter((i) => i.status === "open");
  const building = all.filter((i) => i.status === "in build");
  const dropped = all.filter((i) => i.status === "dropped");
  const [picked, setPicked] = useState<string[]>([]);
  const sel = picked.filter((id) => open.some((i) => i.id === id));
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const pid = feature.pieceId;

  const act = async (p: Promise<FeatureView>) => {
    setError(null);
    try {
      onChange(await p);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    }
  };
  async function build() {
    if (!sel.length || starting) return;
    setStarting(true);
    setError(null);
    try {
      router.push(`/f/${await buildIssues(feature.id, sel)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't start the build");
      setStarting(false);
    }
  }
  const toggle = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const builds = new Map((feature.builds ?? []).map((b) => [b.featureId, b]));

  return (
    <div className="space-y-8">
      <AddIssue onAdd={(b) => act(addIssue(feature.id, { ...b, pieceId: pid || undefined, source: "manual" }))} />

      {error && (
        <button onClick={() => setError(null)} className="chip !border-bad text-bad">
          {error} ✕
        </button>
      )}

      <section>
        <div className="mb-3 flex items-center gap-3">
          <span className="eyebrow">open · {open.length}</span>
          {open.length > 1 && (
            <button
              type="button"
              onClick={() => setPicked(sel.length === open.length ? [] : open.map((i) => i.id))}
              className="font-mono text-[11px] text-grey transition-colors hover:text-ink"
            >
              {sel.length === open.length ? "none" : "all"}
            </button>
          )}
          <AnimatePresence>
            {sel.length > 0 && (
              <motion.button
                type="button"
                initial={{ opacity: 0, transform: reduce ? "none" : "translateX(-4px)" }}
                animate={{ opacity: 1, transform: "translateX(0px)" }}
                exit={{ opacity: 0, transition: { duration: 0.12 } }}
                transition={{ duration: 0.2 }}
                onClick={build}
                disabled={starting}
                className="btn btn-primary ml-auto !py-1.5 text-[13px]"
              >
                {starting ? "starting…" : `build from ${sel.length} issue${sel.length > 1 ? "s" : ""} →`}
              </motion.button>
            )}
          </AnimatePresence>
        </div>
        {open.length ? (
          <ul className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {open.map((i) => (
                <IssueRow key={i.id} issue={i} picked={sel.includes(i.id)} onPick={() => toggle(i.id)}>
                  <Edit issue={i} onSave={(p) => act(patchIssue(feature.id, pid, i.id, p))} />
                  <RowAction label="drop" onClick={() => act(patchIssue(feature.id, pid, i.id, { status: "dropped" }))} />
                </IssueRow>
              ))}
            </AnimatePresence>
          </ul>
        ) : (
          <div className="flex flex-col items-center py-12 text-center">
            <div className="display text-3xl">
              no <span className="outlined">issues</span> yet
            </div>
            <p className="mt-2 max-w-sm text-[13px] text-grey">
              tell lambda what&apos;s wrong or worth changing, flag a story, flow, sketch mark or table, or add one above
            </p>
          </div>
        )}
      </section>

      {building.length > 0 && (
        <section>
          <div className="eyebrow mb-3">in build · {building.length}</div>
          <ul className="flex flex-col gap-2">
            {building.map((i) => (
              <IssueRow key={i.id} issue={i} quiet>
                <Title issue={i} />
                {i.build && (
                  <Link href={`/f/${i.build}`} className="shrink-0 font-mono text-[11px] text-grey underline decoration-line-2 underline-offset-2 hover:text-ink">
                    {builds.has(i.build) ? "open build →" : "build →"}
                  </Link>
                )}
              </IssueRow>
            ))}
          </ul>
        </section>
      )}

      {dropped.length > 0 && (
        <section>
          <div className="eyebrow mb-3">dropped · {dropped.length}</div>
          <ul className="flex flex-col gap-2">
            {dropped.map((i) => (
              <IssueRow key={i.id} issue={i} quiet>
                <Title issue={i} struck />
                <RowAction label="restore" onClick={() => act(patchIssue(feature.id, pid, i.id, { status: "open" }))} />
                <RowAction label="delete" onClick={() => act(removeIssue(feature.id, pid, i.id))} />
              </IssueRow>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function IssueRow({ issue, picked, onPick, quiet, children }: { issue: Issue; picked?: boolean; onPick?: () => void; quiet?: boolean; children: React.ReactNode }) {
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={spring}
      data-focus-id={issue.id}
      className={clsx("card flex items-start gap-3 px-4 py-3", quiet && "opacity-70", picked && "!border-ink")}
    >
      {onPick ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={!!picked}
          aria-label={`pick "${issue.title}"`}
          onClick={onPick}
          className={clsx(
            "mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] border transition-colors duration-150",
            picked ? "border-ink bg-ink text-paper" : "border-line-2 hover:border-ink-2",
          )}
        >
          {picked && (
            <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden>
              <path d="M1.5 4.5l2 2 4-4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
            </svg>
          )}
        </button>
      ) : (
        <span className={clsx("mt-1.5 size-1.5 shrink-0 rounded-full", KIND_TONE[issue.kind])} />
      )}
      {children}
    </motion.li>
  );
}

// title + meta line: kind · where it came from · what it's pinned on (click → show it)
function Title({ issue, struck }: { issue: Issue; struck?: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <p className={clsx("text-[14.5px] leading-snug text-ink", struck && "line-through decoration-grey/60")}>{issue.title}</p>
      {issue.detail && <p className="mt-1 text-[13px] leading-snug text-ink-2">{issue.detail}</p>}
      <Meta issue={issue} />
    </div>
  );
}

function Meta({ issue }: { issue: Issue }) {
  const src = SOURCE[issue.source];
  const show = () =>
    issue.ref && window.dispatchEvent(new CustomEvent("lambda:focus", { detail: { tab: issue.ref.tab, ref: issue.ref.id, piece: issue.pieceId } }));
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 font-mono text-[10.5px] text-grey">
      <span>{issue.kind}</span>
      {src && <span>· {src}</span>}
      {issue.ref && (
        <button type="button" onClick={show} className="truncate underline decoration-line-2 underline-offset-2 hover:text-ink" title={`show in ${issue.ref.tab}`}>
          · on {issue.ref.tab} “{issue.ref.label}”
        </button>
      )}
    </p>
  );
}

function RowAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="shrink-0 font-mono text-[11px] text-grey transition-colors hover:text-ink">
      {label}
    </button>
  );
}

// click to edit title / detail inline; kind cycles on its dot
function Edit({ issue, onSave }: { issue: Issue; onSave: (p: { title?: string; detail?: string; kind?: IssueKind }) => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(issue.title);
  const [detail, setDetail] = useState(issue.detail ?? "");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  const save = () => {
    setEditing(false);
    if (title.trim() && (title.trim() !== issue.title || detail.trim() !== (issue.detail ?? ""))) onSave({ title, detail });
  };
  if (!editing)
    return (
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => {
            setTitle(issue.title);
            setDetail(issue.detail ?? "");
            setEditing(true);
          }}
          className="block w-full text-left"
          title="edit"
        >
          <span className="text-[14.5px] leading-snug text-ink">{issue.title}</span>
          {issue.detail && <span className="mt-1 block text-[13px] leading-snug text-ink-2">{issue.detail}</span>}
        </button>
        <div className="flex items-center gap-2">
          <Meta issue={issue} />
          <button
            type="button"
            onClick={() => onSave({ kind: KINDS[(KINDS.indexOf(issue.kind) + 1) % KINDS.length] })}
            className="mt-1.5 font-mono text-[10.5px] text-grey/60 transition-colors hover:text-ink"
            title="change kind"
          >
            ↻
          </button>
        </div>
      </div>
    );
  return (
    <div className="min-w-0 flex-1">
      <input
        ref={ref}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-full bg-transparent text-[14.5px] leading-snug text-ink outline-none"
      />
      <textarea
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
        placeholder="detail (optional)"
        rows={2}
        className="mt-1 w-full resize-none bg-transparent text-[13px] leading-snug text-ink-2 outline-none placeholder:text-grey/60"
      />
    </div>
  );
}

function AddIssue({ onAdd }: { onAdd: (b: { title: string; detail?: string; kind: IssueKind }) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<IssueKind>("bug");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    await onAdd({ title, kind });
    setTitle("");
    setBusy(false);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
      className="card flex flex-wrap items-center gap-3 px-4 py-3"
    >
      <span className="font-mono text-[12px] text-grey">+ issue</span>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="what's wrong, or worth changing?"
        maxLength={120}
        className="min-w-0 flex-1 bg-transparent text-[14.5px] text-ink outline-none placeholder:text-grey/70"
      />
      <div className="flex items-center gap-1" role="radiogroup" aria-label="kind">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            onClick={() => setKind(k)}
            className={clsx(
              "rounded-full px-2 py-0.5 font-mono text-[11px] transition-colors duration-150",
              kind === k ? "bg-ink text-paper" : "text-grey hover:text-ink",
            )}
          >
            {k}
          </button>
        ))}
      </div>
      <button type="submit" disabled={!title.trim() || busy} className="btn btn-ghost !py-1 text-[13px]">
        add
      </button>
    </form>
  );
}
