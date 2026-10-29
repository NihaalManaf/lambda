"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeNote, StoryOp } from "@/lib/ops";
import type { FeatureView } from "@/lib/types";
import { applyStoryOpWith } from "@/lib/stories-apply";
import { storiesApi } from "./api";

// Optimistic story edits over POST /api/features/[id]/ops.
// - every op applies locally at once (same reducer as the server, temp ids)
// - network calls run in a serial queue; temp ids are translated to real ids before sending
// - the server feature lands only once the queue drains, so later optimistic edits never flicker back
// - keyOf(id) keeps React keys / layoutIds stable across temp → real id swaps
// - deletes are deferred 5s behind an undo toast, flushed on unmount / pagehide

export type Undo = { key: string; label: string; ops: StoryOp[]; hide: string[]; until: number };
export const UNDO_MS = 5000;

const ID_FIELDS = ["storyId", "criterionId"] as const;

export function useStoryOps(feature: FeatureView, onChange: (f: FeatureView) => void, onError: (msg: string) => void) {
  const fid = feature.id;
  const latest = useRef(feature);
  // callbacks live in refs so `send`/`commit` stay stable (the unmount flush must not re-fire per render)
  const cb = useRef({ onChange, onError });
  useEffect(() => {
    latest.current = feature;
    cb.current = { onChange, onError };
  });

  const real = useRef(new Map<string, string>()); // temp id -> real id
  const alias = useRef(new Map<string, string>()); // real id -> first-seen (temp) id, for stable keys
  const queue = useRef<Promise<void>>(Promise.resolve());
  const inflight = useRef(0);
  const tmp = useRef(0);

  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [undo, setUndo] = useState<Undo | null>(null);
  const pending = useRef(new Map<string, { u: Undo; t: ReturnType<typeof setTimeout> }>());

  const translate = (op: StoryOp): StoryOp => {
    const o = { ...op } as Record<string, unknown>;
    for (const k of ID_FIELDS) if (typeof o[k] === "string") o[k] = real.current.get(o[k] as string) ?? o[k];
    return o as StoryOp;
  };

  const keyOf = useCallback((id: string) => alias.current.get(id) ?? id, []);
  const realOf = useCallback((id: string) => real.current.get(id) ?? id, []);

  const refetch = useCallback(async () => {
    try {
      cb.current.onChange(await storiesApi.get(fid, latest.current.pieceId));
    } catch {
      /* keep what we have */
    }
  }, [fid]);

  // Optimistic apply + queued send. Returns the local notes (refs are temp ids for adds).
  const send = useCallback(
    (ops: StoryOp[]): ChangeNote[] | null => {
      const draft = structuredClone(latest.current);
      const local: ChangeNote[] = [];
      const created: string[][] = [];
      try {
        for (const op of ops) {
          const made: string[] = [];
          local.push(applyStoryOpWith(draft, op, (p) => (made.push(`tmp-${p}-${++tmp.current}`), made[made.length - 1])));
          created.push(made);
        }
      } catch (e) {
        cb.current.onError((e as Error).message);
        return null;
      }
      latest.current = draft;
      cb.current.onChange(draft);

      inflight.current++;
      queue.current = queue.current.then(async () => {
        try {
          const { feature: f, notes } = await storiesApi.ops(fid, ops.map(translate), false, draft.pieceId);
          // map temp ids we minted to the server's
          ops.forEach((op, i) => {
            const made = created[i];
            if (!made.length) return;
            const bind = (t: string | undefined, r: string | undefined) => {
              if (!t || !r || t === r) return;
              real.current.set(t, r);
              alias.current.set(r, alias.current.get(t) ?? t);
            };
            if (op.op === "add_story") {
              bind(made[0], notes[i]?.ref);
              const st = f.stories.find((s) => s.id === notes[i]?.ref);
              made.slice(1).forEach((t, j) => bind(t, st?.acceptance[j]?.id));
            }
            if (op.op === "add_criterion") {
              const sid = real.current.get(op.storyId) ?? op.storyId;
              const st = f.stories.find((s) => s.id === sid);
              bind(made[0], st?.acceptance[st.acceptance.length - 1]?.id);
            }
          });
          if (inflight.current === 1) cb.current.onChange(f);
        } catch (e) {
          cb.current.onError((e as Error).message);
          if (inflight.current === 1) await refetch();
        } finally {
          inflight.current--;
        }
      });
      return local;
    },
    [fid, refetch],
  );

  // ---------- deferred delete + undo ----------

  const commit = useCallback(
    (key: string, keepalive = false) => {
      const p = pending.current.get(key);
      if (!p) return;
      clearTimeout(p.t);
      pending.current.delete(key);
      if (keepalive) {
        storiesApi.ops(fid, p.u.ops.map(translate), true, latest.current.pieceId).catch(() => {});
        return;
      }
      send(p.u.ops);
      setHidden((h) => {
        const n = new Set(h);
        p.u.hide.forEach((x) => n.delete(x));
        return n;
      });
      setUndo((u) => (u?.key === key ? null : u));
    },
    [fid, send],
  );

  const removeLater = useCallback(
    (label: string, ops: StoryOp[], hide: string[]) => {
      const key = `${hide.join("|")}-${Date.now()}`;
      const u: Undo = { key, label, ops, hide, until: Date.now() + UNDO_MS };
      pending.current.set(key, { u, t: setTimeout(() => commit(key), UNDO_MS) });
      setHidden((h) => new Set([...h, ...hide]));
      setUndo(u);
    },
    [commit],
  );

  const restore = useCallback((key: string) => {
    const p = pending.current.get(key);
    if (!p) return;
    clearTimeout(p.t);
    pending.current.delete(key);
    setHidden((h) => {
      const n = new Set(h);
      p.u.hide.forEach((x) => n.delete(x));
      return n;
    });
    setUndo((u) => (u?.key === key ? null : u));
  }, []);

  // never lose a delete: flush on tab close / unmount
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });
  useEffect(() => {
    const map = pending.current;
    const flush = () => [...map.keys()].forEach((k) => commitRef.current(k, true));
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  return { send, keyOf, realOf, hidden, undo, removeLater, restore, dismissUndo: () => setUndo(null) };
}
