"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import type { Feature } from "@/lib/types";
import { NEW_FEATURE_EVENT } from "@/lib/desktop";

export function Composer() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // mac app: File → New Feature (⌘N) focuses the composer
  useEffect(() => {
    const focus = () => {
      titleRef.current?.focus();
      titleRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    window.addEventListener(NEW_FEATURE_EVENT, focus);
    return () => window.removeEventListener(NEW_FEATURE_EVENT, focus);
  }, []);

  async function submit() {
    if (!title.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/features", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, brief }),
      });
      if (!res.ok) throw new Error();
      const f = (await res.json()) as Feature;
      router.push(`/f/${f.id}`);
    } catch {
      setErr("couldn't create — try again");
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
      }}
      className="card relative overflow-hidden p-5 shadow-[0_20px_60px_-30px_rgba(24,24,24,0.35)] md:p-6"
    >
      <p className="eyebrow mb-3">new feature</p>
      <input
        ref={titleRef}
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="what are we building?"
        maxLength={80}
        className="display w-full bg-transparent text-3xl outline-none placeholder:text-line-2 md:text-4xl"
      />
      <textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        placeholder="short brief — who, why, rough shape"
        rows={2}
        className="mt-3 w-full resize-none bg-transparent text-[15px] text-ink-2 outline-none placeholder:text-grey/60"
      />
      <div className="mt-3 flex items-center justify-between border-t border-line pt-4">
        <span className="font-mono text-[11px] text-grey">⌘ ↵</span>
        <div className="flex items-center gap-3">
          <AnimatePresence>
            {err && (
              <motion.span
                initial={{ opacity: 0, x: 6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                className="text-xs text-bad"
              >
                {err}
              </motion.span>
            )}
          </AnimatePresence>
          <button type="submit" className="btn btn-primary" disabled={!title.trim() || busy}>
            {busy ? "opening…" : "shape it →"}
          </button>
        </div>
      </div>
      {busy && <div className="shimmer absolute inset-x-0 bottom-0 h-0.5" />}
    </form>
  );
}
