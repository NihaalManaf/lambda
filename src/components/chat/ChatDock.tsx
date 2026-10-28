"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import clsx from "clsx";
import type { ChatTurn } from "@/lib/chat";
import type { ChangeNote } from "@/lib/ops";
import type { Feature } from "@/lib/types";
import { focusRef, useChat } from "./useChat";

// "talk to lambda": a calm, non-modal dock. Collapsed → pill bottom-right. Open → right sheet (md+) or
// bottom sheet (phones). Tabs stay live behind it so every change lands where you can see it.

const SPRING: Transition = { type: "spring", stiffness: 420, damping: 42, mass: 0.9 };
const INSTANT: Transition = { duration: 0 };

const MQ = "(min-width: 768px)";
const subscribe = (cb: () => void) => {
  const m = window.matchMedia(MQ);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
const useWide = () => useSyncExternalStore(subscribe, () => window.matchMedia(MQ).matches, () => true);

const SUGGESTIONS: { label: string; text: string; fill?: boolean }[] = [
  { label: "add a story…", text: "add a story for ", fill: true },
  { label: "missing edge cases?", text: "what edge cases are missing?" },
  { label: "split this smaller", text: "split this smaller" },
  { label: "find the slack thread…", text: "find the slack thread about ", fill: true },
];

export default function ChatDock({ feature, onChange }: { feature: Feature; onChange: (f: Feature) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [instant, setInstant] = useState(false); // keyboard toggles never animate
  const reduce = useReducedMotion();
  const wide = useWide();
  const pillRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const { thread, pending, busy, send, stop, dismiss, clear, undo, undoError } = useChat(feature, onChange);

  // >= 1024 the workspace reflows beside the open sheet (Workspace main: lg:[html[data-dock=open]_&]:mr-[400px])
  useEffect(() => {
    const el = document.documentElement;
    if (open) el.dataset.dock = "open";
    else delete el.dataset.dock;
    return () => void delete el.dataset.dock;
  }, [open]);

  const show = useCallback((via: "key" | "click") => {
    setInstant(via === "key");
    returnTo.current = document.activeElement as HTMLElement | null;
    setOpen(true);
  }, []);
  const hide = useCallback((via: "key" | "click") => {
    setInstant(via === "key");
    setOpen(false);
    const back = returnTo.current;
    requestAnimationFrame(() => (back && document.contains(back) && back !== document.body ? back : pillRef.current)?.focus());
  }, []);

  // ⌘K / ctrl+K toggles from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      e.preventDefault();
      if (open) hide("key");
      else show("key");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, show, hide]);

  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  const submit = (text = draft) => {
    if (!text.trim() || busy) return;
    send(text);
    setDraft("");
  };

  const pick = (s: (typeof SUGGESTIONS)[number]) => {
    if (s.fill) {
      setDraft(s.text);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        el?.focus();
        el?.setSelectionRange(s.text.length, s.text.length);
      });
    } else submit(s.text);
  };

  const onFocusChip = (n: ChangeNote) => {
    focusRef(n);
    if (!wide) hide("click"); // phones: the sheet covers the tab
  };

  const t = instant ? INSTANT : SPRING;
  const off = reduce ? { opacity: 0 } : wide ? { x: "100%" } : { y: "100%" };
  const visible = pending ? thread.slice(0, pending.base) : thread;
  const last = visible[visible.length - 1];

  return (
    <>
      <AnimatePresence initial={false}>
        {!open && (
          <motion.button
            key="pill"
            ref={pillRef}
            type="button"
            onClick={() => show("click")}
            aria-label="talk to lambda (⌘K)"
            title="talk to lambda · ⌘K"
            aria-expanded={false}
            className="fixed bottom-5 right-5 z-40 flex h-11 min-w-11 items-center justify-center gap-2.5 rounded-full bg-ink px-3 text-[13.5px] font-semibold text-paper shadow-[0_14px_40px_-14px_rgba(24,24,24,0.6)] transition-transform duration-150 ease-[var(--ease-out)] active:scale-[0.97] min-[1600px]:pl-3.5 min-[1600px]:pr-2.5"
            initial={{ opacity: 0, scale: 0.96, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: instant ? 0 : 0.12 } }}
            transition={instant ? INSTANT : { type: "spring", stiffness: 500, damping: 36 }}
          >
            <span className="display text-lg leading-none">λ</span>
            {/* compact λ over the gutter; the label only where there's room beside the page */}
            <span className="hidden min-[1600px]:inline">talk to lambda</span>
            {busy && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-lilac" aria-label="working" />}
            <kbd className="hidden rounded-full bg-paper/15 px-2 py-0.5 font-mono text-[11px] font-normal text-paper/80 min-[1600px]:inline">⌘K</kbd>
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {open && (
          <motion.aside
            key="dock"
            ref={sheetRef}
            role="dialog"
            aria-modal={false}
            aria-label="talk to lambda"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                hide("key");
              }
            }}
            className="fixed inset-x-0 bottom-0 z-50 flex h-[78dvh] flex-col rounded-t-[26px] border-t border-line bg-paper shadow-[0_-24px_60px_-30px_rgba(24,24,24,0.35)] md:inset-x-auto md:bottom-0 md:right-0 md:top-[57px] md:h-auto md:w-[400px] md:rounded-none md:border-l md:border-t-0 md:shadow-[-24px_0_60px_-34px_rgba(24,24,24,0.3)]"
            initial={off}
            animate={{ x: 0, y: 0, opacity: 1 }}
            exit={{ ...off, transition: instant ? INSTANT : { ...SPRING, stiffness: 520 } }}
            transition={t}
          >
            <header className="flex items-center justify-between gap-3 px-5 pb-2 pt-4">
              <div className="flex items-center gap-2">
                <span className="display text-xl leading-none">λ</span>
                <span className="eyebrow">talk to lambda</span>
              </div>
              <div className="flex items-center gap-1">
                {thread.length > 0 && !busy && (
                  <button
                    type="button"
                    onClick={() => clear()}
                    className="rounded-full px-2.5 py-1 text-[12px] text-grey transition-colors hover:bg-paper-2 hover:text-ink active:scale-[0.97]"
                  >
                    new thread
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => hide("click")}
                  aria-label="close (esc)"
                  className="grid h-8 w-8 place-items-center rounded-full text-grey transition-colors hover:bg-paper-2 hover:text-ink active:scale-[0.96]"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                    <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </header>

            <Thread
              turns={visible}
              pending={pending}
              onFocusChip={onFocusChip}
              onRetry={(text) => {
                dismiss();
                submit(text);
              }}
              onDismiss={dismiss}
              lastUserText={[...visible].reverse().find((x) => x.role === "user")?.text}
              lastId={last?.id}
              undoId={!busy && !pending ? feature.chatUndo?.turnId : undefined}
              onUndo={undo}
              undoError={undoError}
              empty={!visible.length && !pending}
              onPick={pick}
              busy={busy}
            />

            <Composer
              inputRef={inputRef}
              value={draft}
              onChange={setDraft}
              onSubmit={() => submit()}
              busy={busy}
              onStop={stop}
            />
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}

// ---------- thread ----------

function Thread({
  turns, pending, onFocusChip, onRetry, onDismiss, lastUserText, lastId, undoId, onUndo, undoError, empty, onPick, busy,
}: {
  undoId?: string;
  onUndo: () => void;
  undoError: string | null;
  turns: ChatTurn[];
  pending: ReturnType<typeof useChat>["pending"];
  onFocusChip: (n: ChangeNote) => void;
  onRetry: (text: string) => void;
  onDismiss: () => void;
  lastUserText?: string;
  lastId?: string;
  empty: boolean;
  onPick: (s: (typeof SUGGESTIONS)[number]) => void;
  busy: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true); // follow the bottom unless the reader scrolled up

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  if (empty) return <Empty onPick={onPick} />;

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4 pt-2"
      aria-live="polite"
      aria-busy={busy}
    >
      <ol className="flex flex-col gap-4">
        {turns.map((t) => (
          <li key={t.id}>
            {t.role === "user" ? (
              <UserBubble text={t.text} />
            ) : (
              <Reply
                text={t.text}
                changes={t.notes ?? []}
                error={t.error}
                undone={t.undone}
                onUndo={t.id === undoId ? onUndo : undefined}
                undoError={t.id === undoId ? undoError : null}
                onFocusChip={onFocusChip}
                onRetry={t.id === lastId && t.error && t.error !== "stopped" && lastUserText && !busy ? () => onRetry(lastUserText) : undefined}
              />
            )}
          </li>
        ))}
        {pending && (
          <>
            <li>
              <UserBubble text={pending.user} fresh />
            </li>
            <li>
              <Reply
                text={pending.text}
                changes={pending.changes}
                streaming={!pending.error}
                error={pending.error}
                onFocusChip={onFocusChip}
                onRetry={pending.error ? () => onRetry(pending.user) : undefined}
                onDismiss={pending.error ? onDismiss : undefined}
              />
            </li>
          </>
        )}
      </ol>
    </div>
  );
}

function UserBubble({ text, fresh }: { text: string; fresh?: boolean }) {
  return (
    <motion.div
      className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-[18px] rounded-br-md bg-paper-2 px-3.5 py-2 text-[13.5px] leading-snug text-ink"
      initial={fresh ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
    >
      {text}
    </motion.div>
  );
}

function Reply({
  text, changes, streaming, error, undone, onUndo, undoError, onFocusChip, onRetry, onDismiss,
}: {
  undone?: boolean;
  onUndo?: () => void;
  undoError?: string | null;
  text: string;
  changes: ChangeNote[];
  streaming?: boolean;
  error?: string;
  onFocusChip: (n: ChangeNote) => void;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  const thinking = streaming && !text && !changes.length;
  return (
    <div className="flex flex-col gap-2">
      {thinking && <Thinking />}
      {changes.length > 0 && (
        <ul className={clsx("flex flex-wrap gap-1.5", undone && "opacity-45 [&_button]:line-through")} aria-label="changes">
          {changes.map((n, i) => (
            <ChangeChip key={i} note={n} onClick={() => onFocusChip(n)} animate={!!streaming} />
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
      {(text || (streaming && !thinking)) && (
        <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink-2">
          {text}
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
      <style>{`
        @keyframes chat-caret { 0%, 45% { opacity: 1 } 55%, 100% { opacity: 0 } }
        .chat-caret { animation: chat-caret 1s steps(1) infinite; }
      `}</style>
    </div>
  );
}

const SIGN = {
  "+": { glyph: "+", cls: "bg-ok/8 text-ok border-ok/20" },
  "~": { glyph: "~", cls: "bg-lilac-soft text-ink border-lilac/50" },
  "−": { glyph: "−", cls: "bg-bad/8 text-bad border-bad/20" },
} as const;

function ChangeChip({ note, onClick, animate }: { note: ChangeNote; onClick: () => void; animate: boolean }) {
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
        title={`show in ${note.tab}`}
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
      <style>{`
        @keyframes chat-dot { 0%, 100% { opacity: .25; transform: translateY(0) } 50% { opacity: 1; transform: translateY(-2px) } }
        .chat-dot { animation: chat-dot 1s var(--ease-out) infinite; }
        @media (prefers-reduced-motion: reduce) { .chat-dot { animation: none; opacity: .6 } }
      `}</style>
    </div>
  );
}

function Empty({ onPick }: { onPick: (s: (typeof SUGGESTIONS)[number]) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-end overflow-y-auto px-5 pb-4">
      <div className="relative flex items-end justify-between gap-2">
        <div className="pb-6">
          <h2 className="display text-[40px]">
            say it,
            <br />
            <span className="text-grey">lambda edits.</span>
          </h2>
          <p className="mt-3 max-w-[200px] text-[13px] leading-snug text-grey">stories, flows, context — changes land live.</p>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/art/scribe-stylus.webp" alt="" aria-hidden className="pointer-events-none -mr-3 w-[150px] select-none fade-b" draggable={false} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-full border border-line-2 bg-card px-3 py-1.5 text-[12.5px] text-ink-2 transition-[transform,background-color] duration-150 hover:bg-paper-2 hover:text-ink active:scale-[0.97]"
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- composer ----------

function Composer({
  inputRef, value, onChange, onSubmit, busy, onStop,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  onStop: () => void;
}) {
  // autosize: grow with content up to ~6 lines
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value, inputRef]);

  const can = value.trim().length > 0 && !busy;
  return (
    <form
      className="border-t border-line/70 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex items-end gap-2 rounded-[20px] border border-line-2 bg-card py-1.5 pl-3.5 pr-1.5 transition-[border-color,box-shadow] duration-150 focus-within:border-ink focus-within:shadow-[0_0_0_3px_rgba(231,163,255,0.4)]">
        <textarea
          ref={inputRef}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={busy ? "lambda is working…" : "add a story, fix a flow, find a thread…"}
          aria-label="message lambda"
          className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-snug text-ink outline-none placeholder:text-grey"
        />
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="stop"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-paper-2 text-ink transition-transform active:scale-[0.94]"
          >
            <span className="h-2.5 w-2.5 rounded-[2px] bg-ink" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!can}
            aria-label="send (enter)"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink text-paper transition-[transform,opacity] duration-150 active:scale-[0.94] disabled:opacity-25"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path d="M7 12V2M2.5 6.5L7 2l4.5 4.5" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
      <div className="mt-1.5 flex justify-between px-1 font-mono text-[10.5px] text-grey/80">
        <span>enter send · shift+enter newline</span>
        <span>esc close</span>
      </div>
    </form>
  );
}
