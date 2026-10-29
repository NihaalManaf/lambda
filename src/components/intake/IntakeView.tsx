"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import clsx from "clsx";
import BriefCard from "@/components/brief/BriefCard";
import Scribe from "@/components/Scribe";
import { inline } from "@/components/inline";
import { visibleText, type Ask } from "@/lib/intake-parse";
import type { ChatMessage, Feature, FeatureView } from "@/lib/types";
import { useIntake } from "./useIntake";

// The intake conversation: a Claude Code session on the repo's main branch asks what's unclear, then writes
// the brief. Calm, centred column; lambda's turns are plain text, questions are chips, the live trace is
// one shimmering line. When the brief lands it settles into a card, then hands over to the workspace.

type AnyFeature = Feature | FeatureView;
const ease = [0.23, 1, 0.32, 1] as const;
const HANDOFF_MS = 2400;
const started = new Set<string>(); // opener sent (strict-mode double mount, remounts)

export default function IntakeView({
  feature,
  onChange,
  onDone,
}: {
  feature: AnyFeature;
  onChange: (f: AnyFeature) => void;
  onDone?: (f: AnyFeature) => void;
}) {
  const reduce = useReducedMotion();
  const { pending, busy, send, stop, skip, skipping, skipError, brief, settled, dismiss, repo } = useIntake(feature, onChange);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const all = feature.chat ?? [];
  const turns = (pending ? all.slice(0, pending.base) : all).filter((m) => m.source === "intake");

  // Enter on the title opened this view: start the conversation with the notes (or the title)
  useEffect(() => {
    if (repo === undefined || busy || brief || started.has(feature.id)) return;
    if ((feature.chat ?? []).some((m) => m.source === "intake")) return;
    started.add(feature.id);
    void send(feature.brief.trim() || feature.title);
  }, [repo, busy, brief, feature.id, feature.chat, feature.brief, feature.title, send]);

  // brief landed + feature settled: let the card breathe, then hand over
  const handedOff = useRef(false);
  const handOffRef = useRef(() => {});
  useEffect(() => {
    handOffRef.current = () => {
      if (!settled || handedOff.current) return;
      handedOff.current = true;
      onChange(settled);
      onDone?.(settled);
    };
  });
  const handOff = () => handOffRef.current();
  useEffect(() => {
    if (!settled) return;
    const t = setTimeout(() => handOffRef.current(), HANDOFF_MS);
    return () => clearTimeout(t);
  }, [settled]);

  // follow the conversation down unless the reader scrolled up
  const pinned = useRef(true);
  useEffect(() => {
    const on = () => (pinned.current = window.innerHeight + window.scrollY > document.documentElement.scrollHeight - 160);
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  useLayoutEffect(() => {
    if (pinned.current) window.scrollTo({ top: document.documentElement.scrollHeight });
  });

  const submit = (text = draft) => {
    if (!text.trim() || busy || brief) return;
    void send(text);
    setDraft("");
    pinned.current = true;
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // the open questions = the ask turns after the last developer turn
  const lastUser = turns.map((t) => t.role).lastIndexOf("user");
  const openAsks = busy || brief ? [] : turns.slice(lastUser + 1).filter((t) => t.ask);
  const lastErrorTurn = [...turns].reverse().find((t) => t.role === "assistant");
  const retryText = lastErrorTurn?.error && lastErrorTurn.error !== "stopped" && !busy ? turns[lastUser]?.text : undefined;
  const sha = feature.intake?.mainSha?.slice(0, 7);
  const firstTurn = !turns.length && !!pending && !pending.text;

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-57px)] w-full max-w-[680px] flex-col px-4 pt-10 md:px-5 md:pt-14">
      <header className="mb-8">
        <div className="flex items-center gap-3">
          <p className="eyebrow">new feature · talking it through</p>
        </div>
        <h1 className="display mt-3 text-[40px] text-ink md:text-[52px]">{feature.title}</h1>
        <p className="mt-3 font-mono text-[11.5px] text-grey">
          {repo === undefined ? (
            " "
          ) : repo ? (
            <>
              reading {repo} @ main{sha ? <span className="text-grey/70"> · {sha}</span> : null} · read-only
            </>
          ) : (
            <>
              no repo set — questions won&apos;t see the code ·{" "}
              <Link href="/settings" className="underline decoration-line-2 underline-offset-2 hover:text-ink">
                settings
              </Link>
            </>
          )}
        </p>
      </header>

      <ol className="flex flex-1 flex-col gap-5 pb-6" aria-live="polite" aria-busy={busy}>
        {turns
          .filter((t) => !openAsks.includes(t)) // open questions render as one chip group below
          .map((t) => (
            <li key={t.id}>
              <Turn turn={t} />
            </li>
          ))}
        {openAsks.length > 0 && (
          <li>
            <AskGroup key={openAsks[0].id} asks={openAsks.map((t) => t.ask!)} onSend={submit} />
          </li>
        )}
        {retryText && (
          <li className="flex items-center gap-2 text-[12.5px]">
            <button type="button" onClick={() => submit(retryText)} className="chip !border-bad/30 !text-bad transition-transform duration-150 active:scale-[0.97]">
              retry
            </button>
          </li>
        )}
        {pending && (
          <>
            {pending.user && (
              <li>
                <UserBubble text={pending.user} fresh />
              </li>
            )}
            <li>
              <Live pending={pending} reduce={!!reduce} art={firstTurn} onDismiss={dismiss} />
            </li>
          </>
        )}
        <AnimatePresence>
          {brief && (
            <motion.li
              key="brief"
              layout
              initial={{ opacity: 0, transform: reduce ? "none" : "translateY(12px) scale(0.985)" }}
              animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
              transition={reduce ? { duration: 0.2 } : { type: "spring", duration: 0.55, bounce: 0.12 }}
              className="mt-2"
            >
              <BriefCard brief={brief} compact />
              <div className="mt-4 flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 font-mono text-[11.5px] text-grey">
                  <Dots />
                  {settled
                    ? `shaping ${brief.pieces.length > 1 ? `${brief.pieces.length} pieces` : "it"} — stories, flows, edge cases`
                    : "writing the brief"}
                </span>
                <button type="button" onClick={handOff} disabled={!settled} className="btn btn-primary !py-2 text-[13px]">
                  open workspace →
                </button>
              </div>
            </motion.li>
          )}
        </AnimatePresence>
      </ol>

      {!brief && (
        <div className="sticky bottom-0 z-10 -mx-4 bg-gradient-to-t from-paper from-70% to-paper/0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-6 md:-mx-5 md:px-5">
          <Composer
            inputRef={inputRef}
            value={draft}
            onChange={setDraft}
            onSubmit={() => submit()}
            busy={busy}
            onStop={stop}
          />
          <div className="mt-2 flex items-center justify-between gap-3 px-1">
            <button
              type="button"
              onClick={() => void skip()}
              disabled={skipping}
              className="rounded-full px-2.5 py-1 text-[12.5px] text-grey transition-[transform,color,background-color] duration-150 hover:bg-paper-2 hover:text-ink active:scale-[0.97] disabled:opacity-50"
            >
              {skipping ? "shaping…" : "skip — just shape it"}
            </button>
            {skipError ? (
              <span className="truncate text-[12px] text-bad" title={skipError}>
                {skipError.length > 60 ? "couldn't shape it" : skipError}
              </span>
            ) : (
              <span className="hidden font-mono text-[10.5px] text-grey/80 sm:inline">enter send · shift+enter newline · “go” when it&apos;s clear</span>
            )}
          </div>
        </div>
      )}
      <style>{`
        @keyframes intake-trace { from { background-position: 100% 0 } to { background-position: -100% 0 } }
        .intake-trace {
          background: linear-gradient(90deg, var(--grey) 0%, var(--grey) 40%, var(--ink) 50%, var(--grey) 60%, var(--grey) 100%);
          background-size: 200% 100%;
          -webkit-background-clip: text; background-clip: text; color: transparent;
          animation: intake-trace 1.8s linear infinite;
        }
        @keyframes intake-caret { 0%, 45% { opacity: 1 } 55%, 100% { opacity: 0 } }
        .intake-caret { animation: intake-caret 1s steps(1) infinite; }
        @keyframes intake-dot { 0%, 100% { opacity: .25 } 50% { opacity: 1 } }
        .intake-dot { animation: intake-dot 1.1s var(--ease-out) infinite; }
      `}</style>
    </div>
  );
}

// ---------- turns ----------

function Turn({ turn }: { turn: ChatMessage }) {
  if (turn.role === "user") return <UserBubble text={turn.text} />;
  if (turn.ask) return <p className="text-[13px] leading-snug text-grey">{turn.ask.question}</p>; // answered: a quiet line
  return (
    <div className="flex flex-col gap-1.5">
      {turn.text && <Prose text={turn.text} />}
      {turn.error && turn.error !== "stopped" && (
        <span className="text-[12.5px] text-bad" title={turn.error}>
          {turn.error.length > 80 ? "couldn't finish this turn" : turn.error}
        </span>
      )}
      {turn.error === "stopped" && <span className="font-mono text-[11px] text-grey">stopped</span>}
    </div>
  );
}

function UserBubble({ text, fresh }: { text: string; fresh?: boolean }) {
  return (
    <motion.div
      className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-[18px] rounded-br-md bg-paper-2 px-3.5 py-2 text-[14px] leading-snug text-ink"
      initial={fresh ? { opacity: 0, transform: "translateY(6px)" } : false}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      transition={{ duration: 0.2, ease }}
    >
      {text}
    </motion.div>
  );
}

// `code` spans and **bold** without a markdown dependency; everything else stays plain
function Prose({ text, caret }: { text: string; caret?: boolean }) {
  return (
    <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink-2">
      {inline(text, "text-[13px]")}
      {caret && <span className="intake-caret ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px] rounded-full bg-ink/70" aria-hidden />}
    </p>
  );
}

function Live({
  pending,
  reduce,
  art,
  onDismiss,
}: {
  pending: NonNullable<ReturnType<typeof useIntake>["pending"]>;
  reduce: boolean;
  art: boolean;
  onDismiss: () => void;
}) {
  const text = visibleText(pending.text);
  const streaming = !pending.error;
  return (
    <div className="flex flex-col gap-2">
      {text && <Prose text={text} caret={streaming} />}
      {streaming && (
        <div className="flex items-end justify-between gap-4">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={pending.trace || "thinking"}
              initial={{ opacity: 0, filter: reduce ? "none" : "blur(2px)" }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              transition={{ duration: 0.18, ease }}
              className="intake-trace block truncate font-mono text-[12px]"
            >
              {pending.trace ? `${pending.trace}…` : "thinking…"}
            </motion.span>
          </AnimatePresence>
          {art && <Scribe size="xs" className="-mb-2 shrink-0 opacity-90" />}
        </div>
      )}
      {pending.error && (
        <div className="flex items-center gap-2 text-[12.5px]">
          <span className="truncate text-bad" title={pending.error}>
            {pending.error.length > 60 ? "lost the connection" : pending.error}
          </span>
          <button type="button" onClick={onDismiss} className="text-grey transition-colors hover:text-ink">
            dismiss
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- questions as chips ----------

function AskGroup({ asks, onSend }: { asks: Ask[]; onSend: (text: string) => void }) {
  const [picked, setPicked] = useState<string[][]>(() => asks.map(() => []));
  const instant = asks.length === 1 && !asks[0].multi; // one single-choice question: a click answers it
  const toggle = (qi: number, opt: string) => {
    if (instant) return onSend(opt);
    setPicked((cur) =>
      cur.map((sel, i) => (i !== qi ? sel : asks[qi].multi ? (sel.includes(opt) ? sel.filter((x) => x !== opt) : [...sel, opt]) : sel[0] === opt ? [] : [opt])),
    );
  };
  const answer = () => {
    const lines = asks.flatMap((a, i) => (picked[i].length ? [asks.length === 1 ? picked[i].join(", ") : `${a.question} → ${picked[i].join(", ")}`] : []));
    if (lines.length) onSend(lines.join("\n"));
  };
  const any = picked.some((p) => p.length);

  return (
    <motion.div
      className="flex flex-col gap-4"
      initial={{ opacity: 0, transform: "translateY(6px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      transition={{ duration: 0.22, ease }}
    >
      {asks.map((a, qi) => (
        <div key={a.question} className="flex flex-col gap-2">
          <p className="text-[14.5px] font-semibold leading-snug text-ink">
            {a.question}
            {a.multi && <span className="ml-2 font-mono text-[10.5px] font-normal uppercase tracking-[0.1em] text-grey">pick any</span>}
          </p>
          {a.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {a.options.map((o, oi) => {
                const on = picked[qi].includes(o);
                return (
                  <motion.button
                    key={o}
                    type="button"
                    aria-pressed={instant ? undefined : on}
                    onClick={() => toggle(qi, o)}
                    initial={{ opacity: 0, transform: "translateY(4px)" }}
                    animate={{ opacity: 1, transform: "translateY(0px)" }}
                    transition={{ duration: 0.2, ease, delay: 0.04 * oi + 0.06 * qi }}
                    className={clsx(
                      "rounded-full border px-3 py-1.5 text-[13px] transition-[transform,background-color,color,border-color] duration-150 active:scale-[0.97]",
                      on ? "border-ink bg-ink text-paper" : "border-line-2 bg-card text-ink-2 hover:border-ink-2 hover:text-ink",
                    )}
                  >
                    {o}
                  </motion.button>
                );
              })}
            </div>
          )}
        </div>
      ))}
      {!instant && (
        <div>
          <button type="button" onClick={answer} disabled={!any} className="btn btn-primary !px-3.5 !py-1.5 text-[13px]">
            send answers
          </button>
        </div>
      )}
    </motion.div>
  );
}

function Dots() {
  return (
    <span className="flex items-center gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className="intake-dot h-1.5 w-1.5 rounded-full bg-lilac" style={{ animationDelay: `${i * 150}ms` }} />
      ))}
    </span>
  );
}

// ---------- composer ----------

function Composer({
  inputRef,
  value,
  onChange,
  onSubmit,
  busy,
  onStop,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  onStop: () => void;
}) {
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value, inputRef]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="flex items-end gap-2 rounded-[22px] border border-line-2 bg-card py-2 pl-4 pr-2 shadow-[0_18px_50px_-30px_rgba(24,24,24,0.4)] transition-[border-color,box-shadow] duration-150 focus-within:border-ink focus-within:shadow-[0_0_0_3px_rgba(231,163,255,0.4)]"
    >
      <textarea
        ref={inputRef}
        rows={1}
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder={busy ? "lambda is reading the code…" : "answer, add detail, or say “go”"}
        aria-label="reply to lambda"
        className="max-h-[180px] min-h-[24px] flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-snug text-ink outline-none placeholder:text-grey"
      />
      {busy ? (
        <button
          type="button"
          onClick={onStop}
          aria-label="stop"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-paper-2 text-ink transition-transform duration-150 active:scale-[0.94]"
        >
          <span className="h-2.5 w-2.5 rounded-[2px] bg-ink" />
        </button>
      ) : (
        <button
          type="submit"
          disabled={!value.trim()}
          aria-label="send (enter)"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ink text-paper transition-[transform,opacity] duration-150 active:scale-[0.94] disabled:opacity-25"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <path d="M7 12V2M2.5 6.5L7 2l4.5 4.5" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </form>
  );
}
