"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatEvent, ChatTurn } from "@/lib/chat";
import type { ChangeNote } from "@/lib/ops";
import type { FeatureView } from "@/lib/types";

// One in-flight turn rendered optimistically on top of the persisted thread (feature.chat).
export interface Pending {
  user: string;
  text: string;
  changes: ChangeNote[];
  code: { question: string; text: string }[]; // ask_codebase answers in this turn
  status?: string; // live trace line ("asking the code…"), cleared by the next text
  error?: string; // transport failure (server never persisted a reply)
  base: number; // thread length when sent: persisted turns past this belong to the pending turn
}

const pq = (p?: string) => (p ? `?piece=${encodeURIComponent(p)}` : "");

export const threadOf = (f: FeatureView): ChatTurn[] => f.chat ?? [];

// pieceId = the piece selected in the workspace (default: the view's piece)
export function useChat(feature: FeatureView, onChange: (f: FeatureView) => void, pieceId?: string) {
  const [pending, setPending] = useState<Pending | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fid = feature.id;
  const thread = threadOf(feature);
  const threadLen = useRef(thread.length);
  threadLen.current = thread.length;
  const changeRef = useRef(onChange);
  const pieceRef = useRef(pieceId ?? feature.pieceId);
  pieceRef.current = pieceId ?? feature.pieceId;
  useEffect(() => {
    changeRef.current = onChange;
  });

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || abortRef.current) return;
      const ac = new AbortController();
      abortRef.current = ac;
      const sentAt = threadLen.current;
      setPending({ user: text, text: "", changes: [], code: [], base: sentAt });
      let finished = false;
      const handle = (e: ChatEvent) => {
        if (e.type === "text") setPending((p) => p && { ...p, text: p.text + e.delta, status: undefined });
        else if (e.type === "status") setPending((p) => p && { ...p, status: e.text });
        else if (e.type === "code") setPending((p) => p && { ...p, code: [...p.code, { question: e.question, text: e.text }], status: undefined });
        else if (e.type === "change") setPending((p) => p && { ...p, changes: [...p.changes, e.note] });
        else if (e.type === "feature") changeRef.current(e.feature);
        else if (e.type === "done" || e.type === "error") finished = true; // persisted turn carries any error
      };
      try {
        const res = await fetch(`/api/features/${fid}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, pieceId: pieceRef.current || undefined }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          const b = await res.json().catch(() => ({}));
          throw new Error(b.error ?? `request failed (${res.status})`);
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (chunk.startsWith("data: ")) {
              try {
                handle(JSON.parse(chunk.slice(6)) as ChatEvent);
              } catch {}
            }
          }
        }
        if (!finished) throw new Error("connection dropped");
        setPending(null);
      } catch (e) {
        if (ac.signal.aborted) {
          // the server finishes the in-flight op, then persists the turn as "stopped": wait for that turn
          // (not just the first GET) so late-committed changes and the reply both land
          setPending(null);
          void (async () => {
            for (let i = 0; i < 40; i++) {
              const f = (await fetch(`/api/features/${fid}${pq(pieceRef.current)}`)
                .then((r) => (r.ok ? r.json() : null))
                .catch(() => null)) as FeatureView | null;
              const t = f ? threadOf(f) : [];
              if (f && t.length > sentAt + 1 && t[t.length - 1].role === "assistant") return changeRef.current(f);
              await new Promise((r) => setTimeout(r, Math.min(250 * (i + 1), 1500)));
            }
          })();
        } else setPending((p) => p && { ...p, error: e instanceof Error ? e.message : String(e) });
      } finally {
        abortRef.current = null;
      }
    },
    [fid],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const dismiss = useCallback(() => setPending(null), []);

  const clear = useCallback(async () => {
    const res = await fetch(`/api/features/${fid}/chat${pq(pieceRef.current)}`, { method: "DELETE" });
    if (res.ok) changeRef.current((await res.json()) as FeatureView);
  }, [fid]);

  const [undoError, setUndoError] = useState<string | null>(null);
  const undo = useCallback(async () => {
    setUndoError(null);
    const res = await fetch(`/api/features/${fid}/chat/undo${pq(pieceRef.current)}`, { method: "POST" }).catch(() => null);
    const body = await res?.json().catch(() => null);
    if (res?.ok && body) changeRef.current(body as FeatureView);
    else setUndoError((body as { error?: string } | null)?.error ?? "couldn't undo");
  }, [fid]);

  return { thread, pending, busy: !!pending && !pending.error, send, stop, dismiss, clear, undo, undoError };
}

// Tell the workspace to show a ref (and the piece it landed in). Workspace / tabs listen for this.
export function focusRef(note: ChangeNote) {
  window.dispatchEvent(new CustomEvent("lambda:focus", { detail: { tab: note.tab, ref: note.ref, scope: note.scope, piece: note.piece } }));
}
