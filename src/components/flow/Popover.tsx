"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";

// Small popover pinned under (or over, when there's no room) a live anchor rect. Follows the anchor every
// frame while open, so it rides along when the chart re-layouts. Scales in from the anchor side.

type Rect = { left: number; top: number; width: number; height: number };

export default function Popover({
  anchor,
  onClose,
  children,
  label,
}: {
  anchor: () => Rect | null;
  onClose: () => void;
  children: React.ReactNode;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; above: boolean } | null>(null);
  const reduce = useReducedMotion();
  const anchorRef = useRef(anchor);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    anchorRef.current = anchor;
    closeRef.current = onClose;
  });

  // track the anchor each frame (cheap: one rect read) and only re-render on real movement
  useLayoutEffect(() => {
    let raf = 0;
    let last = "";
    const tick = () => {
      const r = anchorRef.current();
      const el = ref.current;
      if (!r) return closeRef.current();
      const w = el?.offsetWidth ?? 280;
      const h = el?.offsetHeight ?? 160;
      const gap = 10;
      const above = r.top + r.height + gap + h > window.innerHeight - 8 && r.top - gap - h > 8;
      const x = Math.min(Math.max(12, r.left + r.width / 2 - w / 2), window.innerWidth - w - 12);
      const y = above ? r.top - gap - h : r.top + r.height + gap;
      const key = `${Math.round(x)}:${Math.round(y)}:${above}`;
      if (key !== last) {
        last = key;
        setPos({ x, y, above });
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeRef.current();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    // next tick: don't catch the click that opened us
    const t = window.setTimeout(() => window.addEventListener("pointerdown", down, true));
    window.addEventListener("keydown", key);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, []);

  return createPortal(
    <motion.div
      ref={ref}
      role="dialog"
      aria-label={label}
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: pos ? 1 : 0, scale: 1 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, transition: { duration: 0.1 } }}
      transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
      style={{
        position: "fixed",
        left: pos?.x ?? -9999,
        top: pos?.y ?? -9999,
        transformOrigin: pos?.above ? "bottom center" : "top center",
        zIndex: 60,
      }}
      className="w-[280px] rounded-2xl border border-line-2 bg-card p-2 shadow-[0_18px_40px_-18px_rgba(24,24,24,0.35),0_2px_6px_-2px_rgba(24,24,24,0.08)]"
    >
      {children}
    </motion.div>,
    document.body,
  );
}
