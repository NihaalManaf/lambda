"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { VOICES, source, type Voice } from "./voices-data";

// Two rows of clips drifting in opposite directions, muted, playing only while on screen.
// Hover pauses a row; a tile opens the clip in a player with sound.
// alternate rows so each one mixes slop, agentic engineering and attention
const ROWS = [VOICES.filter((_, i) => i % 2 === 0), VOICES.filter((_, i) => i % 2 === 1)];

// lives here, not globals.css: the track holds two copies, so -50% loops without a seam
const MARQUEE = `
@keyframes voices-marquee { to { transform: translateX(-50%); } }
.voices-track { animation: voices-marquee 100s linear infinite; }
.voices-track[data-reverse] { animation-direction: reverse; }
.voices-row:hover .voices-track, .voices-row:focus-within .voices-track { animation-play-state: paused; }
@media (prefers-reduced-motion: reduce) {
  .voices-track { animation: none; }
  .voices-row { overflow-x: auto; }
}`;
const key = (v: Voice) => (v.on === "x" ? v.id : v.urn);

function Tile({ v, n, onOpen, clone }: { v: Voice; n: number; onOpen: (v: Voice) => void; clone?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => (e.isIntersecting ? el.play().catch(() => {}) : el.pause()), { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <li className="w-[min(78vw,340px)] shrink-0 pr-4" aria-hidden={clone || undefined}>
      <button
        onClick={() => onOpen(v)}
        tabIndex={clone ? -1 : undefined}
        aria-label={`play ${v.who}: ${v.line}`}
        className="card group block w-full overflow-hidden text-left transition-[transform,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-1 hover:border-line-2 active:scale-[0.98]"
      >
        <span className="relative block aspect-video overflow-hidden bg-ink">
          <video
            ref={ref}
            src={v.src}
            poster={v.poster}
            muted
            loop
            playsInline
            preload="none"
            className="h-full w-full object-cover transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.03]"
          />
          <span className="eyebrow absolute left-3 top-3 rounded-full bg-paper/90 px-2.5 py-1 !text-[10px] !text-ink">
            <span className="mr-2 text-grey">{String(n).padStart(2, "0")}</span>
            {v.tag}
          </span>
          <span className="eyebrow absolute right-3 top-3 rounded-full bg-ink/70 px-2.5 py-1 !text-[10px] !text-paper">
            {v.on}
            {v.len && <> · {v.len}</>}
          </span>
        </span>
        <span className="block p-4">
          <span className="display mb-4 line-clamp-3 block text-[1.15rem] leading-[1.12]">{v.line}</span>
          <span className="block truncate text-sm font-semibold">{v.who}</span>
          <span className="block truncate text-xs text-grey">
            {v.role}
            {v.via && <> · via {v.via}</>}
          </span>
        </span>
      </button>
    </li>
  );
}

function Player({ v, onClose }: { v: Voice; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  return (
    <>
      <motion.div
        key="scrim"
        className="fixed inset-0 z-50 bg-ink/40 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
      />
      <motion.div
        key="player"
        role="dialog"
        aria-modal
        aria-label={`${v.who} on ${v.on}`}
        className="fixed inset-x-4 top-1/2 z-50 mx-auto max-w-[920px] -translate-y-1/2 overflow-hidden rounded-[18px] border border-line bg-paper shadow-[0_30px_80px_-30px_rgba(24,24,24,0.45)]"
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={{ type: "spring", stiffness: 460, damping: 36 }}
      >
        <video
          src={v.hd}
          poster={v.poster}
          controls
          autoPlay
          playsInline
          className="block max-h-[70dvh] w-full bg-ink object-contain"
        />
        <div className="flex items-end justify-between gap-6 px-5 py-4">
          <div className="min-w-0">
            <p className="display mb-2 text-[clamp(1.15rem,2vw,1.5rem)] leading-[1.1]">{v.line}</p>
            <p className="truncate text-sm font-semibold">{v.who}</p>
            <p className="truncate text-xs text-grey">
              {v.role}
              {v.via && <> · via {v.via}</>}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <a href={source(v)} target="_blank" rel="noreferrer" className="btn btn-ghost !py-1.5 text-xs">
              open on {v.on} ↗
            </a>
            <button ref={close} onClick={onClose} aria-label="close" className="btn btn-ghost !h-8 !w-8 !justify-center !p-0 text-grey hover:text-ink">
              ×
            </button>
          </div>
        </div>
      </motion.div>
    </>
  );
}

export function Voices() {
  const [open, setOpen] = useState<Voice | null>(null);

  return (
    <section className="pb-12">
      <style>{MARQUEE}</style>
      <div className="mx-auto mb-10 max-w-7xl px-6">
        <p className="eyebrow mb-4">voices</p>
        <h2 className="display text-[clamp(2rem,4.2vw,3.5rem)] [&_em]:italic">
          the people building agents <em>agree.</em>
        </h2>
      </div>

      <div className="flex flex-col gap-4 [mask-image:linear-gradient(to_right,transparent,#000_6%,#000_94%,transparent)]">
        {ROWS.map((row, r) => (
          <div key={r} className="voices-row overflow-hidden">
            <ol className="voices-track flex w-max" data-reverse={r ? "" : undefined}>
              {[false, true].map((clone) =>
                row.map((v) => (
                  <Tile key={`${key(v)}${clone ? "-b" : ""}`} v={v} n={VOICES.indexOf(v) + 1} onOpen={setOpen} clone={clone} />
                )),
              )}
            </ol>
          </div>
        ))}
      </div>

      <AnimatePresence>{open && <Player v={open} onClose={() => setOpen(null)} />}</AnimatePresence>
    </section>
  );
}
