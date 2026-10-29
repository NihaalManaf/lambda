"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, Reorder, motion, useReducedMotion } from "motion/react";
import clsx from "clsx";
import { sortPieces } from "@/lib/pieces";
import type { Job, Piece } from "@/lib/types";
import { PIECE_HOVER } from "./api";
import { useEdgeCases } from "@/components/flow/edgeCases";

const spring = { type: "spring", stiffness: 520, damping: 40 } as const;
const live = (j: Job) => j.status === "queued" || j.status === "running";

export const pieceCounts = (p: Piece) => ({
  stories: p.stories.length,
  flows: p.flowcharts.reduce((a, s) => a + s.charts.length, 0),
  open: p.flowcharts.reduce((a, s) => a + s.charts.reduce((b, c) => b + c.edgeCases.filter((x) => x.handled === null).length, 0), 0),
});

// Numbered build order: 1 send invite → 2 join + expiry → 3 resend/revoke. Click selects, drag reorders,
// ⋯ renames / deletes, story tiles dropped on a card move there. Only rendered for 2+ pieces.
// understand: sub-areas, not PRs — "·" between them and the drag sets reading order.
export default function PieceRail({
  pieces,
  selected,
  onSelect,
  onRename,
  onReorder,
  onRemove,
  onAdd,
  understand = false,
}: {
  understand?: boolean;
  pieces: Piece[];
  selected: string;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onReorder: (ids: string[]) => void;
  onRemove: (id: string) => void;
  onAdd: (title: string) => void;
}) {
  const sorted = sortPieces(pieces);
  const sig = sorted.map((p) => p.id).join(",");
  const [order, setOrder] = useState(() => sorted.map((p) => p.id));
  const [syncedSig, setSyncedSig] = useState(sig);
  const dragging = useRef(false); // for handlers (a click that ends a drag must not select)
  const [isDragging, setDragging] = useState(false);
  const latest = useRef(order);
  useEffect(() => {
    latest.current = order;
  }, [order]);
  // server order changed (add / remove / undo): adopt it, unless mid-drag
  if (sig !== syncedSig && !isDragging) {
    setSyncedSig(sig);
    setOrder(sorted.map((p) => p.id));
  }
  const [over, setOver] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => setOver((e as CustomEvent<string | null>).detail);
    window.addEventListener(PIECE_HOVER, on);
    return () => window.removeEventListener(PIECE_HOVER, on);
  }, []);

  const byId = new Map(sorted.map((p) => [p.id, p]));
  const shownOrder = order.filter((id) => byId.has(id));

  return (
    <nav aria-label={understand ? "sub-areas, drag to set reading order" : "pieces"} className="no-scrollbar -mx-4 mt-8 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
      <div className="flex w-max items-stretch gap-1.5">
        <Reorder.Group axis="x" values={shownOrder} onReorder={setOrder} as="ol" className="flex items-stretch gap-1.5">
          {shownOrder.map((id, i) => {
            const p = byId.get(id)!;
            return (
              <Reorder.Item
                key={id}
                value={id}
                as="li"
                className="flex items-center gap-1.5"
                transition={spring}
                whileDrag={{ scale: 1.02, zIndex: 10 }}
                onDragStart={() => {
                  dragging.current = true;
                  setDragging(true);
                }}
                onDragEnd={() => {
                  // let the click that ends a drag pass first, then commit the new order
                  window.setTimeout(() => {
                    dragging.current = false;
                    setDragging(false);
                    const ids = latest.current.filter((x) => byId.has(x));
                    if (ids.join(",") !== sig) onReorder(ids);
                  }, 0);
                }}
              >
                {i > 0 && (
                  <span className="select-none text-grey/50" aria-hidden>
                    {understand ? "·" : "→"}
                  </span>
                )}
                <PieceCard
                  piece={p}
                  n={i + 1}
                  selected={p.id === selected}
                  dropping={over === p.id && p.id !== selected}
                  canRemove={sorted.length > 1}
                  onSelect={() => !dragging.current && onSelect(p.id)}
                  onRename={(t) => onRename(p.id, t)}
                  onRemove={() => onRemove(p.id)}
                />
              </Reorder.Item>
            );
          })}
        </Reorder.Group>
        <AddPiece onAdd={onAdd} />
      </div>
    </nav>
  );
}

function PieceCard({
  piece,
  n,
  selected,
  dropping,
  canRemove,
  onSelect,
  onRename,
  onRemove,
}: {
  piece: Piece;
  n: number;
  selected: boolean;
  dropping: boolean;
  canRemove: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const c = pieceCounts(piece);
  const edgeCases = useEdgeCases();
  const busy = (piece.jobs ?? []).some(live);
  const failed = (piece.jobs ?? []).some((j) => j.status === "error");

  return (
    <div
      data-piece-drop={piece.id}
      className={clsx(
        "group relative flex min-w-[168px] max-w-[260px] items-stretch rounded-[18px] transition-[box-shadow] duration-150",
        dropping && "ring-2 ring-lilac",
      )}
    >
      {selected && (
        <motion.span
          layoutId="piece-selected"
          transition={spring}
          className="absolute inset-0 rounded-[18px] border border-ink/80 bg-card shadow-[0_10px_30px_-18px_rgba(24,24,24,.45)]"
        />
      )}
      <button
        onClick={onSelect}
        onDoubleClick={() => setEditing(true)}
        aria-current={selected || undefined}
        className={clsx(
          "relative flex min-w-0 flex-1 items-start gap-2.5 rounded-[18px] py-2.5 pl-3 pr-8 text-left transition-[background-color,transform] duration-150 active:scale-[0.98]",
          !selected && "bg-paper-2/70 hover:bg-paper-2",
        )}
      >
        <span className={clsx("display text-[26px] leading-none", selected ? "text-ink" : "text-grey")}>{n}</span>
        <span className="min-w-0 flex-1">
          {editing ? (
            <TitleInput
              value={piece.title}
              onDone={(t) => {
                setEditing(false);
                if (t && t !== piece.title) onRename(t);
              }}
            />
          ) : (
            <span className={clsx("block truncate text-[13px] font-semibold", selected ? "text-ink" : "text-ink-2")}>{piece.title}</span>
          )}
          <span className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-grey">
            <StatusDot busy={busy} failed={failed} has={c.stories > 0} />
            <span className="truncate">
              {c.stories} {c.stories === 1 ? "story" : "stories"}
              {c.flows > 0 && ` · ${c.flows} flows`}
              {edgeCases && c.open > 0 && <span className="text-warn"> · {c.open} open</span>}
            </span>
          </span>
        </span>
      </button>

      <button
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu((m) => (m ? null : { x: r.right, y: r.bottom + 6 }));
        }}
        aria-label={`${piece.title} options`}
        aria-expanded={!!menu}
        className={clsx(
          "absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full text-grey transition-[opacity,background-color] duration-150 hover:bg-paper-2 hover:text-ink focus-visible:opacity-100",
          menu || selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        ⋯
      </button>
      <AnimatePresence>
        {menu && (
          <Menu
            at={menu}
            onClose={() => setMenu(null)}
            items={[
              { label: "rename", run: () => setEditing(true) },
              ...(canRemove ? [{ label: "delete piece", run: onRemove, danger: true }] : []),
            ]}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function StatusDot({ busy, failed, has }: { busy: boolean; failed: boolean; has: boolean }) {
  if (busy)
    return (
      <span className="relative grid h-2.5 w-2.5 place-items-center" title="generating">
        <span className="absolute h-2.5 w-2.5 animate-ping rounded-full bg-lilac/70 [animation-duration:1.6s]" />
        <span className="relative h-1.5 w-1.5 rounded-full bg-lilac" />
      </span>
    );
  return <span className={clsx("h-1.5 w-1.5 rounded-full", failed ? "bg-bad" : has ? "bg-ink-2" : "border border-grey")} title={failed ? "a job failed" : undefined} />;
}

function TitleInput({ value, onDone }: { value: string; onDone: (v: string) => void }) {
  const [v, setV] = useState(value);
  const done = useRef(false);
  const finish = (x: string) => {
    if (done.current) return;
    done.current = true;
    onDone(x.trim());
  };
  return (
    <input
      autoFocus
      value={v}
      maxLength={60}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(v);
        if (e.key === "Escape") finish(value);
      }}
      onBlur={() => finish(v)}
      aria-label="piece title"
      className="w-full min-w-0 rounded-md bg-paper-2 px-1 text-[13px] font-semibold text-ink outline-none ring-1 ring-line-2 focus:ring-ink/40"
    />
  );
}

// portalled + fixed: the rail scrolls sideways, which would clip an absolutely placed menu
function Menu({ at, items, onClose }: { at: { x: number; y: number }; items: { label: string; run: () => void; danger?: boolean }[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const scroll = () => onClose();
    // next tick: the click that opened us must not close us
    const t = window.setTimeout(() => window.addEventListener("pointerdown", down), 0);
    window.addEventListener("keydown", key);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [onClose]);
  return createPortal(
    <motion.div
      ref={ref}
      role="menu"
      initial={{ opacity: 0, transform: reduce ? "none" : "scale(0.96) translateY(-2px)" }}
      animate={{ opacity: 1, transform: "scale(1) translateY(0px)" }}
      exit={{ opacity: 0, transition: { duration: 0.1 } }}
      transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
      style={{ transformOrigin: "top right", top: at.y, left: at.x, translate: "-100% 0" }}
      className="fixed z-50 min-w-[140px] rounded-xl border border-line bg-card p-1 shadow-[0_18px_40px_-20px_rgba(24,24,24,.5)]"
    >
      {items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          onClick={() => {
            onClose();
            it.run();
          }}
          className={clsx(
            "block w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-paper-2",
            it.danger ? "text-bad" : "text-ink-2 hover:text-ink",
          )}
        >
          {it.label}
        </button>
      ))}
    </motion.div>,
    document.body,
  );
}

// "+ piece" → inline title field. Also used alone (1-piece features) as a quiet split affordance.
export function AddPiece({ onAdd, label = "+ piece", className }: { onAdd: (title: string) => void; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState("");
  const submit = () => {
    const t = v.trim();
    if (t) onAdd(t);
    setV("");
    setOpen(false);
  };
  return open ? (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={clsx("flex items-center", className)}
    >
      <input
        autoFocus
        value={v}
        maxLength={60}
        placeholder="piece title"
        onChange={(e) => setV(e.target.value)}
        onBlur={submit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setV("");
            setOpen(false);
          }
        }}
        aria-label="new piece title"
        className="h-full min-h-[36px] w-44 rounded-[18px] border border-dashed border-ink/40 bg-card px-3 text-[13px] outline-none"
      />
    </form>
  ) : (
    <button
      onClick={() => setOpen(true)}
      className={clsx(
        "shrink-0 rounded-[18px] border border-dashed border-line-2 px-3 font-mono text-[11px] text-grey transition-[color,border-color,transform] duration-150 hover:border-ink-2 hover:text-ink active:scale-[0.97]",
        className ?? "min-h-[36px]",
      )}
    >
      {label}
    </button>
  );
}
