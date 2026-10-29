"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { IntakeEvent } from "@/lib/intake";
import type { Ask } from "@/lib/intake-parse";
import type { Brief, Feature, FeatureView } from "@/lib/types";

// The intake turn in flight, rendered on top of the persisted thread (feature.chat, source "intake").
export interface IntakePending {
  user?: string; // undefined when re-attached to a turn started before a reload
  text: string; // raw streamed text (fences hidden at render)
  trace: string; // latest tool line: "reading members/page.tsx"
  asks: Ask[];
  error?: string; // transport failure
  base: number; // thread length when sent
}

type AnyFeature = Feature | FeatureView;

async function readSse(res: Response, on: (e: IntakeEvent) => void) {
  const reader = res.body!.getReader();
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
      if (chunk.startsWith("data: "))
        try {
          on(JSON.parse(chunk.slice(6)) as IntakeEvent);
        } catch {}
    }
  }
}

// Features with phase !== "intake" are held back (`settled`) until the view has shown the brief: the
// workspace swaps the intake out as soon as it sees the new phase.
export function useIntake(feature: AnyFeature, onChange: (f: AnyFeature) => void) {
  const fid = feature.id;
  const [pending, setPending] = useState<IntakePending | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [settled, setSettled] = useState<AnyFeature | null>(null);
  const [skipping, setSkipping] = useState(false);
  const [skipError, setSkipError] = useState<string | null>(null);
  const [repo, setRepo] = useState<string | null | undefined>(undefined);
  const busyRef = useRef(false);
  const changeRef = useRef(onChange);
  useEffect(() => {
    changeRef.current = onChange;
  });
  const threadLen = useRef(0);
  const len = feature.chat?.length ?? 0;
  useEffect(() => {
    threadLen.current = len;
  }, [len]);

  const absorb = useCallback((f: AnyFeature) => {
    if (f.phase === "intake") changeRef.current(f);
    else {
      if (f.briefDoc) setBrief(f.briefDoc);
      setSettled(f);
    }
  }, []);

  const refetch = useCallback(async () => {
    const f = (await fetch(`/api/features/${fid}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as AnyFeature | null;
    if (f) absorb(f);
  }, [fid, absorb]);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busyRef.current) return;
      busyRef.current = true;
      setPending({ user: text, text: "", trace: "", asks: [], base: threadLen.current });
      let finished = false;
      try {
        const res = await fetch(`/api/features/${fid}/intake`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok || !res.body) {
          const b = await res.json().catch(() => ({}));
          throw new Error(b.error ?? `request failed (${res.status})`);
        }
        await readSse(res, (e) => {
          if (e.type === "text") setPending((p) => p && { ...p, text: e.reset ? "" : p.text + e.delta });
          else if (e.type === "status") setPending((p) => p && { ...p, trace: e.line });
          else if (e.type === "ask") setPending((p) => p && { ...p, asks: [...p.asks, e.ask] });
          else if (e.type === "brief") setBrief(e.brief);
          else if (e.type === "feature") absorb(e.feature);
          else finished = true; // done / error: the persisted turn carries any error
        });
        if (!finished) throw new Error("connection dropped");
        setPending(null);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // the turn may still be running server-side (it persists itself): re-attach instead of failing
        setPending((p) => p && { ...p, error: message });
        void refetch();
      } finally {
        busyRef.current = false;
      }
    },
    [fid, absorb, refetch],
  );

  // a turn started before a reload (or in another window): follow its trace until it lands
  const [attached, setAttached] = useState(false);
  useEffect(() => {
    let stop = false;
    void (async () => {
      const s = await fetch(`/api/features/${fid}/intake`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (stop || !s) return;
      setRepo(s.repo ?? null);
      if (!s.live || busyRef.current) return;
      setAttached(true);
      setPending({ text: s.text ?? "", trace: s.trace ?? "", asks: [], base: threadLen.current });
      for (let i = 0; !stop && i < 400; i++) {
        await new Promise((r) => setTimeout(r, 900));
        const t = await fetch(`/api/features/${fid}/intake`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (!t || !t.live) break;
        setPending((p) => p && { ...p, text: t.text ?? p.text, trace: t.trace ?? p.trace });
      }
      if (stop) return;
      setPending(null);
      setAttached(false);
      await refetch();
    })();
    return () => {
      stop = true;
    };
  }, [fid, refetch]);

  const stop = useCallback(() => {
    void fetch(`/api/features/${fid}/intake/stop`, { method: "POST" });
  }, [fid]);

  const skip = useCallback(async () => {
    if (skipping) return;
    setSkipping(true);
    setSkipError(null);
    if (busyRef.current || attached) await fetch(`/api/features/${fid}/intake/stop`, { method: "POST" }).catch(() => null);
    const res = await fetch(`/api/features/${fid}/intake/skip`, { method: "POST" }).catch(() => null);
    const body = await res?.json().catch(() => null);
    if (res?.ok && body) absorb(body as AnyFeature);
    else setSkipError((body as { error?: string } | null)?.error ?? "couldn't shape it — try again");
    setSkipping(false);
  }, [fid, skipping, attached, absorb]);

  const dismiss = useCallback(() => setPending(null), []);

  return { pending, busy: (!!pending && !pending.error) || attached, send, stop, skip, skipping, skipError, brief, settled, dismiss, repo };
}
