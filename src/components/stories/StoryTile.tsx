"use client";

import { useEffect, useRef, type PointerEvent as RPointerEvent } from "react";
import { motion, useDragControls, useReducedMotion } from "motion/react";
import clsx from "clsx";
import type { Priority, Story } from "@/lib/types";
import { Icon, LIVE, LiveIcon, Meter, RoleChip, type Live } from "./bits";

export const tileSpring = { type: "spring", stiffness: 380, damping: 32 } as const;
type Pt = { x: number; y: number };

const EDGE: Record<Live, string> = { untested: "bg-line", running: "bg-warn", passing: "bg-ok", failing: "bg-bad" };

// Tile face: status edge · role monogram · priority meter / "i want" hero / so that / criteria + last run.
// Pointer-drag between columns; a drag never counts as a click.
// Mouse drags at once; touch needs a ~280ms hold so swipes still scroll the page.
const HOLD_MS = 280;
export default function StoryTile({
  story,
  layoutKey,
  live,
  pulse,
  onOpen,
  onPriority,
  onDragMove,
  onDrop,
}: {
  story: Story;
  layoutKey: string;
  live: Live;
  pulse: boolean;
  onOpen: () => void;
  onPriority: (p: Priority) => void;
  onDragMove: (p: Pt) => void;
  onDrop: (p: Pt) => void;
}) {
  const dragged = useRef(false);
  const armed = useRef(false);
  const hold = useRef<{ t: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const el = useRef<HTMLDivElement>(null);
  const controls = useDragControls();
  const reduce = useReducedMotion();

  // once armed, swallow touchmove so the browser doesn't scroll mid-drag
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const block = (e: TouchEvent) => armed.current && e.cancelable && e.preventDefault();
    node.addEventListener("touchmove", block, { passive: false });
    return () => node.removeEventListener("touchmove", block);
  }, []);

  const clearHold = () => {
    if (hold.current) clearTimeout(hold.current.t);
    hold.current = null;
  };
  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (e.pointerType === "mouse") return controls.start(e);
    const native = e.nativeEvent;
    clearHold();
    hold.current = {
      x: e.clientX,
      y: e.clientY,
      t: setTimeout(() => {
        armed.current = true;
        navigator.vibrate?.(8);
        controls.start(native);
      }, HOLD_MS),
    };
  };
  const onPointerMove = (e: RPointerEvent) => {
    const h = hold.current;
    if (h && Math.hypot(e.clientX - h.x, e.clientY - h.y) > 8) clearHold(); // it's a scroll
  };
  const release = () => {
    clearHold();
    armed.current = false;
  };
  const n = story.acceptance.length;

  return (
    <motion.div
      layout
      layoutId={`story-${layoutKey}`}
      data-story={story.id}
      data-story-key={layoutKey}
      transition={tileSpring}
      initial={{ opacity: 0, y: reduce ? 0 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: reduce ? 1 : 0.96, transition: { duration: 0.15 } }}
      ref={el}
      drag
      dragControls={controls}
      dragListener={false}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={release}
      onPointerCancel={release}
      onContextMenu={(e) => armed.current && e.preventDefault()}
      dragSnapToOrigin
      dragElastic={0.9}
      dragMomentum={false}
      whileDrag={{ scale: 1.04, rotate: -1.2, zIndex: 50, boxShadow: "0 18px 40px -16px rgba(24,24,24,.35)" }}
      onDragStart={() => (dragged.current = true)}
      onDrag={(_, i) => onDragMove(i.point)}
      onDragEnd={(_, i) => {
        armed.current = false;
        onDrop(i.point);
        setTimeout(() => (dragged.current = false), 0);
      }}
      onClick={() => !dragged.current && onOpen()}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && (e.preventDefault(), onOpen())}
      tabIndex={0}
      role="button"
      aria-label={`story: ${story.want}`}
      style={{ borderRadius: 18 }}
      className={clsx(
        "card group relative cursor-grab touch-pan-y select-none overflow-hidden py-3.5 pl-[18px] pr-3.5 outline-none [-webkit-touch-callout:none] active:cursor-grabbing",
        "transition-[border-color,box-shadow] duration-150 hover:border-line-2 hover:shadow-[0_8px_24px_-16px_rgba(24,24,24,.35)] focus-visible:ring-2 focus-visible:ring-lilac",
      )}
    >
      {/* status edge */}
      <span className={clsx("absolute inset-y-0 left-0 w-[3px] transition-colors duration-300", EDGE[live])} aria-hidden />
      {/* pulse ring when the chat or a link focuses this story */}
      {pulse && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[18px] ring-2 ring-inset ring-lilac"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 0.4, 1, 0] }}
          transition={{ duration: 1.6, ease: "easeInOut" }}
        />
      )}

      <div className="flex items-center justify-between gap-2">
        <RoleChip role={story.role} />
        <Meter p={story.priority} onPick={onPriority} />
      </div>
      <p className="mt-2.5 font-serif text-[20px] leading-[1.18] tracking-[-0.01em] text-ink">
        {story.want || <span className="text-grey">untitled</span>}
      </p>
      {story.soThat && <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-snug text-grey">so that {story.soThat}</p>}
      <div className="mt-3 flex items-center gap-3 font-mono text-[11px] text-grey">
        <span className={clsx("inline-flex items-center gap-1", !n && "text-bad/80")} title={n ? `${n} acceptance criteria` : "no criteria — not testable"}>
          <Icon name="criteria" size={13} />
          {n}
        </span>
        <span className={clsx("inline-flex items-center gap-1", LIVE[live].text)} title={`browser test: ${LIVE[live].label}`}>
          <LiveIcon s={live} size={13} />
          {live !== "untested" && LIVE[live].label}
        </span>
      </div>
    </motion.div>
  );
}
