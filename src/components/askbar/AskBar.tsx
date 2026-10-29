"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import clsx from "clsx";
import type { ChatView } from "@/lib/chat";
import type { ChangeNote } from "@/lib/ops";
import { featureMode, type FeatureView } from "@/lib/types";
import { focusRef, useChat } from "@/components/chat/useChat";
import Thread, { type Suggestion } from "./Thread";

// ask lambda: a pill pinned bottom-center that grows upward into a thread attached to it (one surface,
// layout-animated), and folds back down. Same feature.chat as the intake: the conversation just continues.
// Click / ⌘K open · Esc / chevron / click outside fold. Keyboard toggles never animate.

const SPRING: Transition = { type: "spring", duration: 0.42, bounce: 0.12 };
const INSTANT: Transition = { duration: 0 };
const PILL_H = 48; // the workspace keeps this much (+ gutter) free at the bottom
const noop = () => () => {};
// portal target exists only on the client (an animated ancestor's transform would pin `fixed` to it)
const useClient = () => useSyncExternalStore(noop, () => true, () => false);

export interface AskBarProps {
  feature: FeatureView;
  pieceId: string; // the selected piece: edits land here unless the message names another
  onChange: (f: FeatureView) => void;
  onFocus?: (tab: ChangeNote["tab"], ref: string | undefined, pieceId: string | undefined, note: ChangeNote) => void;
  view?: ChatView; // what's open outside the workspace (the schema page's table)
}

export default function AskBar({ feature, pieceId, onChange, onFocus, view }: AskBarProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [instant, setInstant] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false); // two-step: a stray click can't wipe the edits
  const reduce = useReducedMotion();
  const shell = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const { thread, pending, busy, send, stop, dismiss, undo, clear, undoError } = useChat(feature, onChange, pieceId || undefined, view);
  const hidden = feature.phase === "intake"; // the intake view has its own composer
  const client = useClient();

  const show = useCallback((via: "key" | "click") => {
    setInstant(via === "key");
    const a = document.activeElement as HTMLElement | null;
    returnTo.current = a && !shell.current?.contains(a) ? a : null;
    setOpen(true);
  }, []);
  const hide = useCallback((via: "key" | "click" | "outside") => {
    setInstant(via === "key");
    setOpen(false);
    if (via === "outside") return; // the click already put focus where the reader wants it
    const back = returnTo.current;
    requestAnimationFrame(() => {
      if (back && document.contains(back) && back !== document.body) back.focus({ preventScroll: true });
      else (document.activeElement as HTMLElement | null)?.blur();
    });
  }, []);

  // ⌘K / ctrl+K from anywhere; Esc folds while focus is in the bar (or nowhere in particular)
  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (open) hide("key");
        else show("key");
      } else if (e.key === "Escape" && open) {
        const a = document.activeElement;
        if (a && a !== document.body && !shell.current?.contains(a)) return;
        e.preventDefault();
        hide("key");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, show, hide, hidden]);

  // click outside folds it (no backdrop: the workspace stays live and clickable)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (shell.current && !shell.current.contains(e.target as Node)) hide("outside");
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, hide]);

  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!confirmClear) return;
    const t = setTimeout(() => setConfirmClear(false), 2600);
    return () => clearTimeout(t);
  }, [confirmClear]);

  const submit = (text = draft) => {
    if (!text.trim() || busy) return;
    if (!open) show("click");
    send(text);
    setDraft("");
  };

  const pick = (s: Suggestion) => {
    if (!s.fill) return submit(s.text);
    setDraft(s.text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      el?.focus();
      el?.setSelectionRange(s.text.length, s.text.length);
    });
  };

  // change card → the workspace selects the piece + tab and pulses the ref; fold so it's in view
  const onChip = (n: ChangeNote) => {
    if (onFocus) onFocus(n.tab, n.ref, n.piece, n);
    else focusRef(n);
    hide("outside");
  };

  if (hidden || !client) return null;

  const visible = pending ? thread.slice(0, pending.base) : thread;
  const lastIntake = visible.findLastIndex((t) => t.source === "intake");
  const shapedAt = lastIntake >= 0 && (feature.briefDoc || feature.phase !== "intake") ? lastIntake : -1;
  const t: Transition = instant || reduce ? INSTANT : SPRING;

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <motion.div
        ref={shell}
        layout
        transition={t}
        role={open ? "dialog" : undefined}
        aria-modal={open ? false : undefined}
        aria-label="ask lambda"
        className={clsx(
          "pointer-events-auto flex w-full flex-col overflow-hidden border bg-paper/85 backdrop-blur-xl backdrop-saturate-150",
          open
            ? "max-w-[min(640px,94vw)] border-line-2 shadow-[0_28px_70px_-28px_rgba(24,24,24,0.45)]"
            : "max-w-[min(560px,90vw)] border-line shadow-[0_16px_44px_-20px_rgba(24,24,24,0.4)]",
        )}
        style={{ borderRadius: open ? 22 : PILL_H / 2 }}
      >
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="panel"
              layout="position"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: instant || reduce ? INSTANT : { duration: 0.2, delay: 0.06, ease: [0.22, 1, 0.36, 1] } }}
              exit={{ opacity: 0, transition: { duration: instant ? 0 : 0.08 } }}
              className="flex max-h-[60vh] min-h-0 flex-col"
            >
              <header className="flex items-center justify-between gap-3 border-b border-line/70 py-2 pl-4 pr-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="display text-lg leading-none">λ</span>
                  <span className="eyebrow whitespace-nowrap">ask lambda</span>
                  {feature.pieces.length > 1 && <PieceTag feature={feature} pieceId={pieceId} />}
                  {thread.some((x) => x.source !== "intake") && !busy && (
                    <button
                      type="button"
                      onClick={() => {
                        if (!confirmClear) return setConfirmClear(true);
                        setConfirmClear(false);
                        void clear();
                      }}
                      onBlur={() => setConfirmClear(false)}
                      title="clear the edits · the intake stays"
                      className={clsx(
                        "ml-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] transition-[color,background-color,transform] duration-150 active:scale-[0.97]",
                        confirmClear ? "bg-paper-2 text-ink" : "text-grey/80 hover:bg-paper-2 hover:text-ink",
                      )}
                    >
                      {confirmClear ? "clear edits?" : "clear edits"}
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => hide("click")}
                    aria-label="fold (esc)"
                    title="fold · esc"
                    className="grid h-8 w-8 place-items-center rounded-full text-grey transition-[color,background-color,transform] duration-150 hover:bg-paper-2 hover:text-ink active:scale-[0.94]"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                      <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              </header>
              <Thread
                turns={visible}
                pending={pending}
                shapedAt={shapedAt}
                undoId={!busy && !pending ? feature.chatUndo?.turnId : undefined}
                onUndo={undo}
                undoError={undoError}
                onChip={onChip}
                onRetry={(text) => {
                  dismiss();
                  submit(text);
                }}
                onDismiss={dismiss}
                onPick={pick}
                busy={busy}
                mode={featureMode(feature)}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <motion.div layout="position" transition={t}>
          {open ? (
            <Composer
              inputRef={inputRef}
              value={draft}
              onChange={setDraft}
              onSubmit={() => submit()}
              busy={busy}
              onStop={stop}
              idle={featureMode(feature) === "understand" ? "ask how it works…" : undefined}
            />
          ) : (
            <button
              type="button"
              onClick={() => show("click")}
              aria-expanded={false}
              aria-label="ask lambda (⌘K)"
              className="group flex w-full items-center gap-3 px-4 text-left transition-transform duration-150 ease-[var(--ease-out)] active:scale-[0.99]"
              style={{ height: PILL_H }}
            >
              <span className="display text-lg leading-none text-ink">λ</span>
              <span className={clsx("min-w-0 flex-1 truncate text-[14px]", busy ? "text-grey" : "text-grey group-hover:text-ink-2")}>
                {busy ? (pending?.status ?? "lambda is working…") : draft.trim() ? draft : "ask lambda…"}
              </span>
              {busy && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-lilac" aria-label="working" />}
              <kbd className="hidden rounded-full border border-line bg-card px-2 py-0.5 font-mono text-[11px] text-grey sm:inline">⌘K</kbd>
            </button>
          )}
        </motion.div>
      </motion.div>
    </div>,
    document.body,
  );
}

function PieceTag({ feature, pieceId }: { feature: FeatureView; pieceId: string }) {
  const p = feature.pieces.find((x) => x.id === pieceId) ?? feature.pieces.find((x) => x.id === feature.pieceId);
  if (!p) return null;
  return (
    <span className="max-w-[180px] truncate rounded-full bg-paper-2 px-2 py-0.5 font-mono text-[10.5px] text-grey" title={`edits land in piece ${p.order}`}>
      {p.order} · {p.title}
    </span>
  );
}

function Composer({
  inputRef, value, onChange, onSubmit, busy, onStop, idle = "add a story, ask the code…",
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  onStop: () => void;
  idle?: string;
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
      className="p-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex items-end gap-2 rounded-[16px] border border-line-2 bg-card py-1 pl-3.5 pr-1 transition-[border-color,box-shadow] duration-150 focus-within:border-ink focus-within:shadow-[0_0_0_3px_rgba(231,163,255,0.4)]">
        <span aria-hidden="true" className="display mb-1.5 mr-1 flex h-6 shrink-0 items-center text-lg leading-none text-ink">λ</span>
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
          placeholder={busy ? "lambda is working…" : idle}
          aria-label="message lambda"
          className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-snug text-ink outline-none placeholder:text-grey"
        />
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="stop"
            className="mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-paper-2 text-ink transition-transform duration-150 active:scale-[0.94]"
          >
            <span className="h-2.5 w-2.5 rounded-[2px] bg-ink" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!can}
            aria-label="send (enter)"
            className="mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink text-paper transition-[transform,opacity] duration-150 active:scale-[0.94] disabled:opacity-25"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path d="M7 12V2M2.5 6.5L7 2l4.5 4.5" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
    </form>
  );
}
