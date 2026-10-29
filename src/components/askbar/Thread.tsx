"use client";

import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import clsx from "clsx";
import { inline } from "@/components/inline";
import type { ChatTurn } from "@/lib/chat";
import type { ChangeNote } from "@/lib/ops";
import type { Pending } from "@/components/chat/useChat";

// The ONE feature thread: intake conversation (muted) → "shaping →" divider where the brief landed →
// edit turns with change cards, and answers from the codebase session.

const EASE = [0.22, 1, 0.36, 1] as const;

export const SUGGESTIONS: { label: string; text: string; fill?: boolean }[] = [
  { label: "add a story…", text: "add a story for ", fill: true },
  { label: "missing edge cases?", text: "what edge cases are missing?" },
  { label: "ask the code…", text: "how does the code handle ", fill: true },
  { label: "split into pieces?", text: "should this ship as separate PRs?" },
];

// Intake history: which option each question got (from the developer's next message, which the intake view
// sends as "question → a, b" lines, or bare "a, b" when it was the only question), and that message with the
// "question →" prefixes dropped (the chips above already show the question).
export function intakeAnswers(turns: ChatTurn[]): { picked: Map<string, string[]>; compact: Map<string, string> } {
  const picked = new Map<string, string[]>();
  const compact = new Map<string, string>();
  let asks: ChatTurn[] = [];
  for (const t of turns) {
    if (t.source !== "intake") continue;
    if (t.role === "assistant") {
      if (t.ask) asks.push(t);
      continue;
    }
    if (asks.length) {
      const lines = t.text.split("\n").map((l) => l.trim()).filter(Boolean);
      const rest: string[] = [];
      for (const line of lines) {
        const hit = asks.find((a) => line.startsWith(`${a.ask!.question} →`));
        const ans = hit ? line.slice(hit.ask!.question.length + 2).trim() : line;
        const target = hit ?? (asks.length === 1 ? asks[0] : undefined);
        const opts = target ? ans.split(/,\s*/).filter((x) => target.ask!.options.includes(x)) : [];
        if (target && opts.length) picked.set(target.id, [...(picked.get(target.id) ?? []), ...opts]);
        rest.push(ans);
      }
      if (asks.some((a) => picked.has(a.id))) compact.set(t.id, rest.join("\n"));
    }
    asks = [];
  }
  return { picked, compact };
}

export default function Thread({
  turns,
  pending,
  shapedAt,
  undoId,
  onUndo,
  undoError,
  onChip,
  onRetry,
  onDismiss,
  onPick,
  busy,
}: {
  turns: ChatTurn[];
  pending: Pending | null;
  shapedAt: number; // index after which the "shaping →" divider sits (-1: none)
  undoId?: string;
  onUndo: () => void;
  undoError: string | null;
  onChip: (n: ChangeNote) => void;
  onRetry: (text: string) => void;
  onDismiss: () => void;
  onPick: (s: (typeof SUGGESTIONS)[number]) => void;
  busy: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true); // follow the bottom unless the reader scrolled up

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  const answers = useMemo(() => intakeAnswers(turns), [turns]);
  const last = turns[turns.length - 1];
  const lastUser = [...turns].reverse().find((t) => t.role === "user")?.text;

  if (!turns.length && !pending)
    return (
      <div className="px-4 pb-3 pt-4">
        <p className="text-[13px] text-grey">stories, flows, pieces, the code — just say it.</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => onPick(s)}
              className="rounded-full border border-line-2 bg-card px-3 py-1.5 text-[12.5px] text-ink-2 transition-[transform,background-color,color] duration-150 hover:bg-paper-2 hover:text-ink active:scale-[0.97]"
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    );

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3 pt-3"
      aria-live="polite"
      aria-busy={busy}
    >
      <ol className="flex flex-col gap-3.5">
        {turns.map((t, i) => (
          <Fragment key={t.id}>
            <li className={clsx(t.source === "intake" && "opacity-60")}>
              {t.role === "user" ? (
                <UserBubble text={answers.compact.get(t.id) ?? t.text} muted={t.source === "intake"} />
              ) : t.source === "code" ? (
                <CodeAnswer text={t.text} />
              ) : t.source === "intake" ? (
                <IntakeReply turn={t} picked={answers.picked.get(t.id)} />
              ) : (
                <Reply
                  text={t.text}
                  changes={t.notes ?? []}
                  error={t.error}
                  undone={t.undone}
                  onUndo={t.id === undoId ? onUndo : undefined}
                  undoError={t.id === undoId ? undoError : null}
                  onChip={onChip}
                  onRetry={t.id === last?.id && t.error && t.error !== "stopped" && lastUser && !busy ? () => onRetry(lastUser) : undefined}
                />
              )}
            </li>
            {i === shapedAt && <ShapingDivider />}
          </Fragment>
        ))}
        {pending && (
          <>
            <li>
              <UserBubble text={pending.user} fresh />
            </li>
            {pending.code.map((c, i) => (
              <li key={`code-${i}`}>
                <CodeAnswer text={c.text} question={c.question} fresh />
              </li>
            ))}
            <li>
              <Reply
                text={pending.text}
                changes={pending.changes}
                status={pending.status}
                streaming={!pending.error}
                error={pending.error}
                onChip={onChip}
                onRetry={pending.error ? () => onRetry(pending.user) : undefined}
                onDismiss={pending.error ? onDismiss : undefined}
              />
            </li>
          </>
        )}
      </ol>
      <style>{`
        @keyframes chat-caret { 0%, 45% { opacity: 1 } 55%, 100% { opacity: 0 } }
        .chat-caret { animation: chat-caret 1s steps(1) infinite; }
        @keyframes chat-dot { 0%, 100% { opacity: .25; transform: translateY(0) } 50% { opacity: 1; transform: translateY(-2px) } }
        .chat-dot { animation: chat-dot 1s var(--ease-out) infinite; }
        @keyframes trace-shimmer { from { background-position: 100% 0 } to { background-position: 0 0 } }
        .trace-shimmer {
          background: linear-gradient(90deg, var(--grey) 0%, var(--grey) 40%, var(--ink) 50%, var(--grey) 60%, var(--grey) 100%);
          background-size: 250% 100%; -webkit-background-clip: text; background-clip: text; color: transparent;
          animation: trace-shimmer 1.6s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .chat-dot { animation: none; opacity: .6 }
          .trace-shimmer { animation: none; color: var(--grey); background: none }
        }
      `}</style>
    </div>
  );
}

function ShapingDivider() {
  return (
    <li className="flex items-center gap-3 py-1" aria-label="intake settled, shaping began">
      <span className="h-px flex-1 bg-line" />
      <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-grey">shaping →</span>
      <span className="h-px flex-1 bg-line" />
    </li>
  );
}

function UserBubble({ text, fresh, muted }: { text: string; fresh?: boolean; muted?: boolean }) {
  return (
    <motion.div
      className={clsx(
        "ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-[18px] rounded-br-md px-3.5 py-2 text-[13.5px] leading-snug text-ink",
        muted ? "bg-paper-2/70" : "bg-paper-2",
      )}
      initial={fresh ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: EASE }}
    >
      {text}
    </motion.div>
  );
}

// intake turns are history here: the question, with the option it got filled in (the rest stay faint)
function IntakeReply({ turn, picked }: { turn: ChatTurn; picked?: string[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {/* an ask turn's text is its question: show it once, above the chips */}
      {turn.text && turn.text !== turn.ask?.question && (
        <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink-2">{inline(turn.text)}</p>
      )}
      {turn.ask && (
        <div className="flex flex-col gap-1">
          <p className="text-[13px] font-medium text-ink-2">{turn.ask.question}</p>
          {turn.ask.options.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {turn.ask.options.map((o) => {
                const on = picked?.includes(o);
                return (
                  <span
                    key={o}
                    className={clsx(
                      "rounded-full border px-2 py-0.5 text-[11.5px]",
                      on ? "border-ink/80 bg-ink text-paper" : clsx("border-line text-grey", picked?.length && "opacity-50"),
                    )}
                  >
                    {o}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}
      {turn.error && turn.error !== "stopped" && <span className="font-mono text-[11px] text-bad">{turn.error.length > 60 ? "couldn't finish" : turn.error}</span>}
    </div>
  );
}

function CodeAnswer({ text, question, fresh }: { text: string; question?: string; fresh?: boolean }) {
  const [more, setMore] = useState(false);
  const long = text.length > 220 || text.split("\n").filter(Boolean).length > 3; // ~3 lines at panel width
  return (
    <motion.div
      className="rounded-[14px] border border-line bg-paper-2/60 px-3.5 py-2.5"
      initial={fresh ? { opacity: 0, y: 4 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: EASE }}
    >
      <div className="mb-1 flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-grey">
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
          <path d="M4 3L1.5 6 4 9M8 3l2.5 3L8 9" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        from the code
      </div>
      {question && <p className="mb-1 truncate text-[12px] text-grey" title={question}>{question}</p>}
      <p className={clsx("whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2", long && !more && "line-clamp-3")}>{inline(text)}</p>
      {long && (
        <button
          type="button"
          onClick={() => setMore((m) => !m)}
          className="mt-1 rounded-full text-[11.5px] text-grey transition-colors duration-150 hover:text-ink"
        >
          {more ? "less" : "more"}
        </button>
      )}
    </motion.div>
  );
}

function Reply({
  text, changes, status, streaming, error, undone, onUndo, undoError, onChip, onRetry, onDismiss,
}: {
  text: string;
  changes: ChangeNote[];
  status?: string;
  streaming?: boolean;
  error?: string;
  undone?: boolean;
  onUndo?: () => void;
  undoError?: string | null;
  onChip: (n: ChangeNote) => void;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  const thinking = streaming && !text && !changes.length && !status;
  return (
    <div className="flex flex-col gap-2">
      {thinking && <Thinking />}
      {streaming && status && <p className="trace-shimmer truncate font-mono text-[11.5px]">{status}</p>}
      {changes.length > 0 && (
        <ul className={clsx("flex flex-wrap gap-1.5", undone && "opacity-45 [&_button]:line-through")} aria-label="changes">
          {changes.map((n, i) => (
            <ChangeChip key={i} note={n} onClick={() => onChip(n)} animate={!!streaming} />
          ))}
          {onUndo && !undone && (
            <li>
              <button
                type="button"
                onClick={onUndo}
                title="roll back every change in this turn"
                className="inline-flex items-center gap-1 rounded-full border border-line-2 py-1 pl-2 pr-2.5 font-mono text-[11px] text-grey transition-[transform,color,border-color] duration-150 hover:border-ink-2 hover:text-ink active:scale-[0.97]"
              >
                <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
                  <path d="M4 2.5L1.5 5 4 7.5M1.8 5h5.7a3 3 0 010 6H5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                undo turn
              </button>
            </li>
          )}
        </ul>
      )}
      {undone && <span className="font-mono text-[11px] text-grey">undone</span>}
      {undoError && <span className="font-mono text-[11px] text-bad">{undoError}</span>}
      {(text || (streaming && !thinking && !status)) && (
        <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink-2">
          {inline(text)}
          {streaming && <span className="chat-caret ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px] rounded-full bg-ink/70" aria-hidden />}
        </p>
      )}
      {error && error !== "stopped" && (
        <div className="flex items-center gap-2 text-[12.5px]">
          <span className="truncate text-bad" title={error}>
            {error.length > 60 ? "couldn't finish" : error}
          </span>
          {onRetry && (
            <button type="button" onClick={onRetry} className="chip !border-bad/30 !text-bad transition-transform active:scale-[0.97]">
              retry
            </button>
          )}
          {onDismiss && (
            <button type="button" onClick={onDismiss} className="text-grey hover:text-ink">
              dismiss
            </button>
          )}
        </div>
      )}
      {error === "stopped" && <span className="font-mono text-[11px] text-grey">stopped</span>}
    </div>
  );
}

const SIGN = {
  "+": { glyph: "+", cls: "bg-ok/8 text-ok border-ok/20" },
  "~": { glyph: "~", cls: "bg-lilac-soft text-ink border-lilac/50" },
  "−": { glyph: "−", cls: "bg-bad/8 text-bad border-bad/20" },
} as const;

export function ChangeChip({ note, onClick, animate }: { note: ChangeNote; onClick: () => void; animate: boolean }) {
  const s = SIGN[note.sign] ?? SIGN["~"];
  return (
    <motion.li
      initial={animate ? { opacity: 0, scale: 0.96, y: 4 } : false}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 520, damping: 34 }}
    >
      <button
        type="button"
        onClick={onClick}
        title={note.what === "piece" ? "show this piece" : `show in ${note.tab}`}
        className={clsx(
          "inline-flex max-w-[320px] items-center gap-1.5 rounded-full border py-1 pl-2 pr-2.5 text-[12px] transition-[transform,filter] duration-150 hover:brightness-[0.97] active:scale-[0.97]",
          s.cls,
        )}
      >
        <span className="font-mono text-[13px] font-semibold leading-none">{s.glyph}</span>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] opacity-70">{note.what}</span>
        <span className="truncate font-semibold">{note.label}</span>
      </button>
    </motion.li>
  );
}

function Thinking() {
  return (
    <div className="flex items-center gap-1.5 py-1" aria-label="lambda is thinking">
      {[0, 1, 2].map((i) => (
        <span key={i} className="chat-dot h-1.5 w-1.5 rounded-full bg-grey/70" style={{ animationDelay: `${i * 140}ms` }} />
      ))}
    </div>
  );
}
