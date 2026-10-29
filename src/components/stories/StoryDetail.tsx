"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import type { StoryOp } from "@/lib/ops";
import type { Acceptance, Piece, Story, VerificationRun } from "@/lib/types";
import { CriterionForm, GWT } from "./Compose";
import { Icon, Inline, LIVE, LiveIcon, Meter, RoleChip, ago, asA, type Live } from "./bits";
import { tileSpring } from "./StoryTile";
import FlagButton from "@/components/issues/FlagButton";

// Expanded story: shares layoutId with its tile. Spec (what you write) is visually separate from
// the result (what the last browser run found). Nothing here is a checkbox.
export default function StoryDetail({
  story,
  layoutKey,
  keyOf,
  hidden,
  run,
  live,
  starting,
  onOp,
  pieces = [],
  onMove,
  onDelete,
  onDeleteCriterion,
  onRun,
  onOpenRun,
  onClose,
}: {
  story: Story;
  layoutKey: string;
  keyOf: (id: string) => string;
  hidden: Set<string>;
  run?: VerificationRun;
  live: Live;
  starting: boolean;
  onOp: (op: StoryOp) => void;
  pieces?: Pick<Piece, "id" | "title" | "order">[]; // the feature's other pieces (move targets)
  onMove?: (pieceId: string) => void;
  onDelete: () => void;
  onDeleteCriterion: (a: Acceptance) => void;
  onRun: () => void;
  onOpenRun: (runId: string) => void;
  onClose: () => void;
}) {
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) =>
      e.key === "Escape" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const sid = story.id;
  const upd = (p: Omit<Extract<StoryOp, { op: "update_story" }>, "op" | "storyId">) => onOp({ op: "update_story", storyId: sid, ...p });
  const criteria = story.acceptance.filter((a) => !hidden.has(`${sid}/${a.id}`));
  const canRun = criteria.length > 0 && live !== "running" && !starting;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto px-3 py-6 md:px-4 md:py-14">
      <motion.div
        className="fixed inset-0 bg-ink/25 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
      />
      <motion.div
        layoutId={`story-${layoutKey}`}
        transition={tileSpring}
        style={{ borderRadius: 24 }}
        role="dialog"
        aria-label="story"
        className="card relative z-10 flex max-h-[calc(100dvh-48px)] w-full min-w-0 max-w-2xl flex-col overflow-hidden shadow-[0_30px_80px_-30px_rgba(24,24,24,.45)] md:max-h-[calc(100dvh-112px)]"
      >
        <span className={clsx("absolute inset-y-0 left-0 w-[3px]", LIVE[live].dot)} aria-hidden />
        {/* capped to the viewport: the body scrolls inside, a bottom fade says there's more */}
        <motion.div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 md:p-7"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { delay: 0.08 } }}
          exit={{ opacity: 0, transition: { duration: 0.05 } }}
        >
          {/* who */}
          <div className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-grey">
              {asA(story.role)}
              <RoleChip role={story.role}>
                <Inline value={story.role} onCommit={(role) => upd({ role })} label="role" className="text-[13px] font-semibold text-ink" />
              </RoleChip>
            </span>
            <FlagButton refTo={{ tab: "stories", id: story.id, label: story.want.slice(0, 60) }} title={`story: ${story.want}`.slice(0, 120)} className="ml-auto" />
            <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-full text-grey transition-colors hover:bg-paper-2 hover:text-ink" aria-label="close">
              <Icon name="close" />
            </button>
          </div>

          {/* what + why */}
          <div className="mt-3 font-serif text-[26px] leading-tight md:text-[32px]">
            <span className="text-grey">i can </span>
            <Inline value={story.want} onCommit={(want) => upd({ want })} placeholder="do something" label="i want" multiline />
          </div>
          <div className="mt-2 text-[15px] text-grey">
            so that{" "}
            <Inline value={story.soThat} onCommit={(soThat) => upd({ soThat })} placeholder="it matters" label="so that" allowEmpty className="text-ink-2" />
          </div>

          {/* meta */}
          <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3 border-y border-line py-3">
            <Meter p={story.priority} onPick={(priority) => upd({ priority })} big />
            {onMove && pieces.length > 0 && (
              <label className="ml-auto inline-flex items-center gap-1 text-xs text-grey transition-colors focus-within:text-ink hover:text-ink">
                <span aria-hidden>→</span>
                <select
                  value=""
                  onChange={(e) => e.target.value && onMove(e.target.value)}
                  aria-label="move to piece"
                  className="cursor-pointer appearance-none bg-transparent pr-1 outline-none"
                >
                  <option value="">move to piece</option>
                  {pieces.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.order} · {p.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button onClick={onDelete} className={clsx(onMove && pieces.length > 0 ? "ml-3" : "ml-auto", "inline-flex items-center gap-1 text-xs text-grey transition-colors hover:text-bad")}>
              <Icon name="trash" size={13} /> delete
            </button>
          </div>

          {/* result: what the browser found (output) */}
          <div className="mt-5 rounded-2xl bg-paper-2/80 p-3.5">
            <div className="flex flex-wrap items-center gap-3">
              <span className="eyebrow">result</span>
              <span className={clsx("inline-flex items-center gap-1.5 text-[13px] font-semibold", LIVE[live].text)}>
                <LiveIcon s={live} />
                {run ? LIVE[live].label : "never run"}
              </span>
              {run && (
                <button onClick={() => onOpenRun(run.id)} className="font-mono text-[11px] text-grey underline-offset-2 hover:text-ink hover:underline">
                  {ago(run.finishedAt ?? run.startedAt)}
                </button>
              )}
              <button
                onClick={onRun}
                disabled={!canRun}
                title={criteria.length ? "run every criterion in a real browser" : "add a criterion first"}
                className="btn btn-primary ml-auto !gap-1.5 !px-3.5 !py-1.5 !text-[13px]"
              >
                {starting ? (
                  <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-paper border-t-transparent" />
                ) : (
                  <Icon name="play" size={12} />
                )}
                run in browser
              </button>
            </div>
            {run?.summary && <p className="mt-2 text-[13px] leading-snug text-ink-2">{run.summary}</p>}
            {!!run?.failures?.length && live === "failing" && (
              <ul className="mt-2 space-y-1">
                {run.failures.slice(0, 4).map((f, i) => (
                  <li key={i} className="flex items-start gap-1.5 font-mono text-[11.5px] leading-snug text-bad">
                    <Icon name="x" size={12} className="mt-px" />
                    {f}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* spec: what you write (input) */}
          <div className="mt-6 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="eyebrow">acceptance</span>
              <span className="font-mono text-[11px] text-grey">{criteria.length}</span>
            </div>
            {!adding && (
              <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1 text-xs font-semibold text-ink-2 transition-colors hover:text-ink">
                <Icon name="plus" size={12} /> criterion
              </button>
            )}
          </div>
          <div className="mt-3 space-y-3">
            <AnimatePresence initial={false} mode="popLayout">
              {criteria.map((a, i) => (
                <motion.div
                  key={keyOf(a.id)}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.15 } }}
                  transition={tileSpring}
                >
                  <Criterion
                    n={i + 1}
                    a={a}
                    live={live}
                    onChange={(criterion) => onOp({ op: "update_criterion", storyId: sid, criterionId: a.id, criterion })}
                    onRemove={() => onDeleteCriterion(a)}
                  />
                </motion.div>
              ))}
              {adding && (
                <motion.div key="__add" layout>
                  <CriterionForm onAdd={(criterion) => onOp({ op: "add_criterion", storyId: sid, criterion })} onClose={() => setAdding(false)} />
                </motion.div>
              )}
            </AnimatePresence>
            {!criteria.length && !adding && (
              <button
                onClick={() => setAdding(true)}
                className="w-full rounded-2xl border border-dashed border-line-2 p-5 text-center text-xs text-grey transition-colors hover:border-ink hover:text-ink"
              >
                no criteria — not testable yet · <span className="font-semibold">add one</span>
              </button>
            )}
          </div>
          <div aria-hidden className="pointer-events-none sticky -bottom-5 -mx-5 -mb-5 mt-2 h-8 bg-gradient-to-t from-card to-transparent md:-bottom-7 md:-mx-7 md:-mb-7" />
        </motion.div>
      </motion.div>
    </div>
  );
}

function Criterion({
  n,
  a,
  live,
  onChange,
  onRemove,
}: {
  n: number;
  a: Acceptance;
  live: Live;
  onChange: (p: Partial<Acceptance>) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const save = () => {
    const steps = text.split("\n").map((s) => s.trim()).filter(Boolean);
    if (steps.join("\n") !== a.steps.join("\n")) onChange({ steps });
    setEditing(false);
  };

  return (
    <div className="group rounded-2xl border border-line bg-paper p-4">
      <div className="flex items-center gap-2">
        <span className="grid h-5 w-5 place-items-center rounded-full bg-ink font-mono text-[10px] text-paper">{n}</span>
        <span className="eyebrow">spec</span>
        <span className={clsx("ml-auto inline-flex items-center gap-1 font-mono text-[11px]", LIVE[live].text)} title="from the story's last browser run">
          <LiveIcon s={live} size={12} />
          {live === "untested" ? "never run" : LIVE[live].label}
        </span>
        <button
          onClick={onRemove}
          className="grid h-6 w-6 place-items-center rounded-full text-grey opacity-60 transition-[opacity,color] duration-150 hover:text-bad group-hover:opacity-100"
          aria-label="remove criterion"
        >
          <Icon name="trash" size={13} />
        </button>
      </div>

      {/* given → when → then */}
      <div className="mt-3 grid gap-1.5 sm:grid-cols-3">
        {GWT.map((g) => (
          <div key={g.k} className={clsx("min-w-0 rounded-xl px-2.5 py-2", g.bg)}>
            <div className="flex items-center gap-1 font-mono text-[9.5px] uppercase tracking-wider text-grey">
              <Icon name={g.k} size={11} className="text-ink-2" />
              {g.k}
            </div>
            <Inline value={a[g.k]} onCommit={(v) => onChange({ [g.k]: v })} label={g.k} multiline className="mt-0.5 text-[13px] leading-snug" />
          </div>
        ))}
      </div>

      {/* browser script: read-only numbered list; "edit" swaps to a textarea */}
      <div className="mt-3.5 flex items-center gap-2">
        <span className="eyebrow">browser test</span>
        <span className="inline-flex items-center gap-1 rounded-full bg-ink py-0.5 pl-2 pr-1 font-mono text-[11.5px] text-paper">
          <Icon name="globe" size={11} />
          <Inline
            value={a.startPath}
            onCommit={(startPath) => onChange({ startPath })}
            label="start path"
            className="!mx-0 hover:!bg-ink-2 focus:!bg-ink-2"
          />
        </span>
        {/* the check stage couldn't back it with the code; editing the route or steps clears it */}
        {a.unverified && (
          <span className="truncate font-mono text-[10.5px] text-warn" title={a.unverified}>
            {a.unverified.startsWith("route ") ? "unverified route" : "unverified"}
          </span>
        )}
        <button
          onClick={() => (editing ? save() : (setText(a.steps.join("\n")), setEditing(true)))}
          className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] text-grey transition-colors hover:text-ink"
        >
          {editing ? (
            "done"
          ) : (
            <>
              <Icon name="pencil" size={11} /> edit
            </>
          )}
        </button>
      </div>
      {editing ? (
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") setEditing(false);
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          }}
          rows={Math.max(3, a.steps.length + 1)}
          aria-label="browser steps, one per line"
          className="mt-2 w-full resize-none rounded-xl border border-ink/40 bg-card px-3 py-2 font-mono text-[12px] leading-relaxed outline-none"
        />
      ) : a.steps.length ? (
        <ol className="mt-2 space-y-0.5 border-l border-line pl-3">
          {a.steps.map((s, i) => (
            <li key={i} className="flex gap-2.5 font-mono text-[12px] leading-relaxed text-ink-2">
              <span className="w-3 shrink-0 text-right text-grey">{i + 1}</span>
              <span className="min-w-0">{s}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 font-mono text-[11.5px] text-grey">no steps yet</p>
      )}
    </div>
  );
}
