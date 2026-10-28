"use client";

import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import type { Annotation, AnnotationKind, Box } from "@/lib/types";
import { buildMarks, kindMeta, textW, type Mark } from "./marks";
import { shotUrl, type SketchMockup } from "./api";

// Real screenshot + sharpie overlay. Overlay lives in screenshot pixel space (viewBox), so it scales with the image.
// Narrow screens: crop to the marks (toggle for the full page) and grow labels to a legible on-screen size.

const NARROW = 640;
const MIN_LABEL_PX = 14; // on-screen
const TEXTISH = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "button", "img", "label", "input", "svg", "blockquote"]);

type View = { x: number; y: number; w: number; h: number };

// Bounding box of every mark, padded for labels, at least ~half a desktop viewport wide.
function cropOf(anns: Annotation[], W: number, H: number): View {
  if (!anns.length) return { x: 0, y: 0, w: W, h: H };
  const bs = anns.flatMap((a) => (a.to ? [a.box, a.to] : [a.box]));
  let x0 = Math.min(...bs.map((b) => b.x)) - 70;
  let x1 = Math.max(...bs.map((b) => b.x + b.w)) + 70;
  let y0 = Math.min(...bs.map((b) => b.y)) - 90;
  let y1 = Math.max(...bs.map((b) => b.y + b.h)) + 90;
  const minW = Math.min(W, 560);
  if (x1 - x0 < minW) {
    const c = (x0 + x1) / 2;
    [x0, x1] = [c - minW / 2, c + minW / 2];
  }
  x0 = Math.max(0, Math.min(x0, W - (x1 - x0)));
  x1 = Math.min(W, x0 + (x1 - x0));
  y0 = Math.max(0, y0);
  y1 = Math.min(H, y1);
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
}

type Part = "box" | "to" | "resize";
type Drag = { id: string; part: Part; x0: number; y0: number; x: number; y: number };

export interface CanvasProps {
  mockup: SketchMockup;
  annotations: Annotation[];
  selectedId: string | null;
  hoverId: string | null;
  mode: "select" | "draw";
  drawKind: AnnotationKind;
  busy: boolean;
  onSelect: (id: string | null) => void;
  onEdit: (a: Annotation) => void;
  onCreate: (kind: AnnotationKind, box: Box) => void;
}

const clampBox = (b: Box, W: number, H: number): Box => {
  const w = Math.max(20, Math.min(b.w, W));
  const h = Math.max(20, Math.min(b.h, H));
  return { x: Math.max(0, Math.min(b.x, W - w)), y: Math.max(0, Math.min(b.y, H - h)), w, h };
};

function applyDrag(a: Annotation, d: Drag, W: number, H: number): Annotation {
  const dx = d.x - d.x0;
  const dy = d.y - d.y0;
  if (d.part === "resize") return { ...a, box: clampBox({ ...a.box, w: a.box.w + dx, h: a.box.h + dy }, W, H) };
  if (d.part === "to" && a.to) return { ...a, to: clampBox({ ...a.to, x: a.to.x + dx, y: a.to.y + dy }, W, H) };
  return { ...a, box: clampBox({ ...a.box, x: a.box.x + dx, y: a.box.y + dy }, W, H) };
}

export default function SketchCanvas(p: CanvasProps) {
  const { mockup: m } = p;
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [cw, setCw] = useState(0);
  const [full, setFull] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setCw(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [draft, setDraft] = useState<{ x0: number; y0: number; x: number; y: number } | null>(null);

  const pt = (e: React.PointerEvent) => {
    const svg = svgRef.current!;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const q = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: Math.round(q.x), y: Math.round(q.y) };
  };

  const startDrag = (e: React.PointerEvent, id: string, part: Part) => {
    if (p.mode !== "select" || e.button !== 0) return;
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    const { x, y } = pt(e);
    setDrag({ id, part, x0: x, y0: y, x, y });
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (p.mode === "draw") {
      svgRef.current?.setPointerCapture(e.pointerId);
      const { x, y } = pt(e);
      setDraft({ x0: x, y0: y, x, y });
    } else p.onSelect(null);
  };

  const onMove = (e: React.PointerEvent) => {
    if (draft) setDraft({ ...draft, ...pt(e) });
    else if (drag) setDrag({ ...drag, ...pt(e) });
  };

  const onUp = () => {
    if (draft) {
      const box = { x: Math.min(draft.x0, draft.x), y: Math.min(draft.y0, draft.y), w: Math.abs(draft.x - draft.x0), h: Math.abs(draft.y - draft.y0) };
      setDraft(null);
      if (box.w > 12 && box.h > 12) p.onCreate(p.drawKind, box);
    }
    if (drag) {
      const a = p.annotations.find((x) => x.id === drag.id);
      const moved = Math.hypot(drag.x - drag.x0, drag.y - drag.y0) > 3;
      setDrag(null);
      if (!a) return;
      if (moved) p.onEdit(applyDrag(a, drag, m.width, m.height));
      p.onSelect(a.id);
    }
  };

  const shown = useMemo(
    () => p.annotations.map((a) => (drag?.id === a.id ? applyDrag(a, drag, m.width, m.height) : a)),
    [p.annotations, drag, m.width, m.height],
  );
  const narrow = cw > 0 && cw < NARROW;
  const cropped = narrow && !full && p.annotations.length > 0;
  // crop follows committed boxes only, so it doesn't jump mid-drag
  const view = useMemo(
    () => (cropped ? cropOf(p.annotations, m.width, m.height) : { x: 0, y: 0, w: m.width, h: m.height }),
    [cropped, p.annotations, m.width, m.height],
  );
  const textScale = cw ? Math.max(1, (MIN_LABEL_PX * view.w) / (26 * cw)) : 1;
  const obstacles = useMemo(
    () => (m.elements ?? []).filter((e) => TEXTISH.has(e.tag) && e.w * e.h < m.width * 360),
    [m.elements, m.width],
  );
  const marks = useMemo(
    () => buildMarks(shown, m.width, m.height, { textScale, obstacles, view }),
    [shown, m.width, m.height, textScale, obstacles, view],
  );
  const focus = p.hoverId ?? p.selectedId;
  const sel = shown.find((a) => a.id === p.selectedId);
  const draftColor = kindMeta(p.drawKind).color;

  return (
    <div ref={wrapRef} className="relative">
    {narrow && p.annotations.length > 0 && (
      <button
        onClick={() => setFull((f) => !f)}
        className="chip absolute right-2 top-2 z-10 bg-card/90 font-mono !text-[11px] backdrop-blur"
      >
        {full ? "zoom to marks" : "whole page"}
      </button>
    )}
    <div className="relative select-none overflow-hidden" style={{ aspectRatio: `${view.w} / ${view.h}` }}>
      {!loaded && <div className="shimmer absolute inset-0" />}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={shotUrl(m.shot)}
        width={m.width}
        height={m.height}
        alt={m.title}
        draggable={false}
        onLoad={() => setLoaded(true)}
        style={{
          width: `${(m.width / view.w) * 100}%`,
          maxWidth: "none",
          marginLeft: `${(-view.x / view.w) * 100}%`,
          marginTop: `${(-view.y / view.w) * 100}%`, // % margins resolve against width
        }}
        className={`block h-auto transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
      />
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        className={`absolute inset-0 h-full w-full touch-none ${p.mode === "draw" ? "cursor-crosshair" : ""}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <motion.g animate={{ opacity: p.busy ? 0.2 : 1 }} transition={{ duration: 0.25 }}>
          {loaded &&
            shown.map((a, i) => (
              <motion.g
                key={`${a.id}:${a.kind}`}
                animate={{ opacity: focus && focus !== a.id ? 0.3 : 1 }}
                transition={{ duration: 0.18 }}
              >
                <MarkView id={a.id} mark={marks[i]} delay={i * 0.18} />
              </motion.g>
            ))}
        </motion.g>

        {/* hit targets: biggest first so small boxes stay grabbable */}
        {p.mode === "select" &&
          [...shown].sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h).map((a) => (
            <g key={a.id} className="cursor-grab active:cursor-grabbing">
              <rect {...xywh(a.box)} fill="transparent" onPointerDown={(e) => startDrag(e, a.id, "box")} />
              {a.kind === "move" && a.to && (
                <rect {...xywh(a.to)} fill="transparent" onPointerDown={(e) => startDrag(e, a.id, "to")} />
              )}
            </g>
          ))}

        {sel && p.mode === "select" && (
          <g pointerEvents="none">
            <rect {...xywh(pad(sel.box, 8))} fill="none" stroke="#e7a3ff" strokeWidth={3} strokeDasharray="6 6" rx={10} />
            <rect
              x={sel.box.x + sel.box.w - 4}
              y={sel.box.y + sel.box.h - 4}
              width={18}
              height={18}
              rx={5}
              fill="#181818"
              stroke="#fff"
              strokeWidth={2}
              pointerEvents="all"
              className="cursor-nwse-resize"
              onPointerDown={(e) => startDrag(e, sel.id, "resize")}
            />
          </g>
        )}

        {draft && (
          <rect
            x={Math.min(draft.x0, draft.x)}
            y={Math.min(draft.y0, draft.y)}
            width={Math.abs(draft.x - draft.x0)}
            height={Math.abs(draft.y - draft.y0)}
            fill={draftColor}
            fillOpacity={0.08}
            stroke={draftColor}
            strokeWidth={3}
            strokeDasharray="8 6"
            rx={6}
          />
        )}
      </svg>
      {p.busy && <div className="shimmer pointer-events-none absolute inset-0 opacity-30 mix-blend-multiply" />}
    </div>
    </div>
  );
}

const xywh = (b: Box) => ({ x: b.x, y: b.y, width: b.w, height: b.h });
const pad = (b: Box, n: number): Box => ({ x: b.x - n, y: b.y - n, w: b.w + 2 * n, h: b.h + 2 * n });

// One annotation's sharpie strokes. Draws on once (mount), then just updates geometry.
const MarkView = memo(function MarkView({ id, mark, delay }: { id: string; mark: Mark; delay: number }) {
  const textDelay = delay + 0.35;
  return (
    <g pointerEvents="none" strokeLinecap="round" strokeLinejoin="round">
      {mark.paths.map((pth, j) =>
        pth.fill ? (
          <motion.path
            key={j}
            d={pth.d}
            fill={pth.fill}
            stroke="none"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay, duration: 0.2 }}
          />
        ) : (
          <motion.path
            key={j}
            d={pth.d}
            fill="none"
            stroke={pth.stroke}
            strokeWidth={pth.width}
            strokeDasharray={pth.dash}
            initial={pth.dash ? { opacity: 0 } : { pathLength: 0, opacity: 0 }}
            animate={pth.dash ? { opacity: pth.faint ? 0.4 : 1 } : { pathLength: 1, opacity: pth.faint ? 0.4 : 1 }}
            transition={{ delay: delay + j * 0.04, duration: pth.faint ? 0.6 : 0.42, ease: [0.65, 0, 0.35, 1] }}
          />
        ),
      )}
      {mark.texts.map((t, j) => {
        const tw = textW(t);
        const w = tw + 40;
        const cid = `clip-${id}-${j}`;
        const turn = `rotate(${t.rot} ${t.x} ${t.y})`;
        return (
          <g key={`t${j}`}>
            <clipPath id={cid}>
              <motion.rect
                x={t.x - 14}
                y={t.y - t.size * 1.6}
                height={t.size * 2.6}
                initial={{ width: 0 }}
                animate={{ width: w }}
                transition={{ delay: textDelay + j * 0.1, duration: Math.min(0.9, 0.25 + t.text.length * 0.025), ease: "linear" }}
              />
            </clipPath>
            {t.backed && (
              // paper card behind the ink: readable over any screenshot
              <rect
                clipPath={`url(#${cid})`}
                x={t.x - 7}
                y={t.y - t.size * 0.98}
                width={tw + 14}
                height={t.size * 1.3}
                rx={t.size * 0.3}
                fill="#f8f8f6"
                fillOpacity={0.9}
                stroke={t.color}
                strokeOpacity={0.25}
                strokeWidth={1.5}
                transform={turn}
              />
            )}
            <text
              clipPath={`url(#${cid})`}
              x={t.x}
              y={t.y}
              transform={turn}
              fill={t.color}
              fontSize={t.size}
              fontWeight={700}
              stroke="#f8f8f6"
              strokeWidth={7}
              style={{ paintOrder: "stroke" }}
              className="font-hand"
            >
              {t.text}
            </text>
          </g>
        );
      })}
    </g>
  );
});
