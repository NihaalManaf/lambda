"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import type { MigrationMeta } from "@/lib/schema/types";

// Timeline of every migration: tick height = size, colour = worst risk. Drag, click or ←/→ to scrub.
// The slot after the last tick is "now" (head).

const BASE = 42; // tick baseline (px from top)
const PAD = 8;
const HEAD_SLOT = 18;

const color = (m: MigrationMeta) => (m.worst === "bad" ? "var(--bad)" : m.worst === "warn" ? "var(--warn)" : "var(--ink-2)");
// rounded: Math.log can differ in the last bit between node and the browser → hydration mismatch
const tickH = (m: MigrationMeta) => Math.round(Math.max(4, Math.min(34, 4 + 7 * Math.log(1 + Math.max(0, m.magnitude)))) * 100) / 100;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export const matchTable = (m: MigrationMeta, q: string) => m.tables.some((t) => t.replace(/^public\./, "").includes(q));

export default function Scrubber({
  migrations,
  index,
  onChange,
  filter,
  onFilter,
  highlight,
}: {
  migrations: MigrationMeta[];
  index: number; // 0..n-1 = a migration, n = head
  onChange: (i: number) => void;
  filter: string;
  onFilter: (q: string) => void;
  highlight?: ReadonlySet<string> | null;
}) {
  const n = migrations.length;
  const scroller = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null);
  const drag = useRef(false);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 2px tick + 1px gap minimum; spread out when there's room
  const pitch = Math.max(3, n ? (w - PAD * 2 - HEAD_SLOT) / n : 3);
  const inner = Math.max(w, PAD * 2 + n * pitch + HEAD_SLOT);
  const xOf = (i: number) => (i >= n ? PAD + n * pitch + HEAD_SLOT / 2 : PAD + i * pitch + 1);

  const q = filter.trim().toLowerCase();
  const months = useMemo(() => {
    const out: { i: number; label: string }[] = [];
    let last = "";
    migrations.forEach((m, i) => {
      const k = m.date.slice(0, 7);
      if (k === last || !/^\d{4}-\d{2}/.test(k)) return;
      last = k;
      // a sparse first month would collide with the next label: keep the later one
      if (out.length && (i - out[out.length - 1].i) * pitch < 28) out.pop();
      out.push({ i, label: MONTHS[Number(k.slice(5, 7)) - 1] ?? k });
    });
    return out;
  }, [migrations, pitch]);

  const fade = (m: MigrationMeta) => (highlight ? !highlight.has(m.id) : q ? !matchTable(m, q) : false);

  const at = (clientX: number) => {
    const el = scroller.current!;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft - PAD;
    return Math.max(0, Math.min(n, Math.round((x - 1) / pitch)));
  };

  // keep the handle in view when stepping with the keyboard
  useEffect(() => {
    const el = scroller.current;
    if (!el || drag.current) return;
    const x = xOf(index);
    if (x < el.scrollLeft + 24 || x > el.scrollLeft + el.clientWidth - 24)
      el.scrollTo({ left: x - el.clientWidth / 2, behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, pitch]);

  const step = (e: React.KeyboardEvent) => {
    const by = e.shiftKey ? 10 : 1;
    const to = e.key === "ArrowLeft" ? index - by : e.key === "ArrowRight" ? index + by : e.key === "Home" ? 0 : e.key === "End" ? n : null;
    if (to === null) return;
    e.preventDefault();
    onChange(Math.max(0, Math.min(n, to)));
  };

  const tip = hover && hover.i < n ? migrations[hover.i] : null;

  return (
    <div className="card flex flex-col gap-2 p-2 sm:flex-row sm:items-stretch">
      <div className="relative min-w-0 flex-1">
        <div
          ref={scroller}
          role="slider"
          tabIndex={0}
          aria-label="migration"
          aria-valuemin={0}
          aria-valuemax={n}
          aria-valuenow={index}
          aria-valuetext={index >= n ? "now" : migrations[index]?.title}
          onKeyDown={step}
          onPointerDown={(e) => {
            drag.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            const i = at(e.clientX);
            onChange(i);
            setHover({ i, x: xOf(i) - e.currentTarget.scrollLeft });
          }}
          onPointerMove={(e) => {
            // the tip rides the handle while dragging, the pointer while hovering
            const i = at(e.clientX);
            if (drag.current && i !== index) onChange(i);
            setHover({ i, x: xOf(i) - e.currentTarget.scrollLeft });
          }}
          onPointerUp={() => {
            drag.current = false;
            setHover(null);
          }}
          onPointerCancel={() => {
            drag.current = false;
            setHover(null);
          }}
          onPointerLeave={() => !drag.current && setHover(null)}
          className="no-scrollbar relative h-16 cursor-pointer touch-pan-x select-none overflow-x-auto overflow-y-hidden rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-lilac"
        >
          <div className="relative h-full" style={{ width: inner }}>
            <svg width={inner} height={64} className="absolute inset-0" aria-hidden>
              <line x1={PAD} x2={inner - PAD} y1={BASE + 0.5} y2={BASE + 0.5} stroke="var(--line)" />
              {migrations.map((m, i) => {
                const h = tickH(m);
                const lit = highlight?.has(m.id);
                return (
                  <rect
                    key={m.id}
                    x={PAD + i * pitch}
                    y={BASE - h}
                    width={2}
                    height={h}
                    rx={1}
                    fill={lit ? "var(--ink)" : color(m)}
                    opacity={fade(m) ? 0.15 : hover?.i === i ? 1 : 0.85}
                    style={{ transition: "opacity 160ms var(--ease-out)" }}
                  />
                );
              })}
              {highlight &&
                migrations.map((m, i) =>
                  highlight.has(m.id) ? (
                    <circle
                      key={m.id}
                      cx={PAD + i * pitch + 1}
                      cy={BASE + 5}
                      r={2}
                      fill="var(--lilac)"
                      stroke="var(--ink)"
                      strokeWidth={0.8}
                    />
                  ) : null,
                )}
              <circle cx={xOf(n)} cy={BASE - 4} r={4} fill="var(--card)" stroke="var(--ink)" strokeWidth={1.4} />
              {months.map((m) => (
                <text key={m.i} x={PAD + m.i * pitch} y={58} fontSize={10} fontFamily="var(--font-mono)" fill="var(--grey)">
                  {m.label}
                </text>
              ))}
              <text x={xOf(n)} y={58} fontSize={10} textAnchor="middle" fontFamily="var(--font-mono)" fill="var(--ink-2)">
                now
              </text>
            </svg>
            <motion.div
              aria-hidden
              className="pointer-events-none absolute top-1 h-[44px] w-0"
              initial={false}
              animate={{ x: xOf(index) }}
              transition={{ type: "spring", stiffness: 700, damping: 48 }}
            >
              <span className="absolute -left-px top-1 h-full w-[2px] rounded-full bg-ink" />
              <span className="absolute -left-[6px] -top-0.5 size-3 rounded-full border-[1.5px] border-ink bg-lilac shadow-[0_1px_0_var(--line-2)]" />
            </motion.div>
          </div>
        </div>
        {tip && hover && (
          <div
            className="pointer-events-none absolute bottom-full z-30 mb-1.5 w-max max-w-64 -translate-x-1/2 rounded-lg border border-line-2 bg-paper px-2 py-1 shadow-[2px_3px_0_var(--line)]"
            style={{ left: Math.max(60, hover.x) }}
          >
            <div className="font-hand text-[14px] leading-tight">{tip.title}</div>
            <div className="font-mono text-[10px] text-grey">{tip.date}</div>
          </div>
        )}
      </div>
      <label className="flex shrink-0 items-center gap-1.5 rounded-xl border border-line-2 bg-paper px-2.5 sm:w-44">
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="shrink-0 text-grey"
          aria-hidden
        >
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5L14 14" strokeLinecap="round" />
        </svg>
        <input
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          placeholder="table"
          className="h-9 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-grey"
        />
        {filter && (
          <button type="button" onClick={() => onFilter("")} className="text-[12px] text-grey hover:text-ink" title="clear">
            ✕
          </button>
        )}
      </label>
    </div>
  );
}
