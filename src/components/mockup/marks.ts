import rough from "roughjs";
import type { Annotation, AnnotationKind, Box } from "@/lib/types";

// Sharpie geometry: roughjs -> plain path data, rendered by React so motion can draw it on.

export const KINDS: { kind: AnnotationKind; name: string; color: string; hint: string }[] = [
  { kind: "insert", name: "insert", color: "#1f9a55", hint: "new ui here" },
  { kind: "remove", name: "remove", color: "#e2382b", hint: "remove" },
  { kind: "move", name: "move", color: "#1f5fd6", hint: "move this" },
  { kind: "change-text", name: "copy", color: "#e2382b", hint: "new copy" },
  { kind: "restyle", name: "restyle", color: "#9b4dca", hint: "restyle" },
  { kind: "note", name: "note", color: "#181818", hint: "question?" },
];
export const kindMeta = (k: AnnotationKind) => KINDS.find((x) => x.kind === k)!;

export interface MarkPath {
  d: string;
  stroke: string;
  width: number;
  fill?: string; // solid fills (stroke "none") fade in instead of drawing on
  dash?: string;
  faint?: boolean;
}
export interface MarkText {
  x: number;
  y: number; // baseline
  text: string;
  size: number;
  color: string;
  rot: number;
  anchor?: Box; // placed around this box by buildMarks; absent = fixed position
  backed?: boolean; // paper backing so it reads over the screenshot
}
export interface Mark {
  paths: MarkPath[];
  texts: MarkText[];
}

const gen = rough.generator();

// Stable per-annotation randomness: same id -> same wobble, same tilt.
export function seedOf(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h) % 2147483647 || 1;
}
const tilt = (seed: number) => ((seed % 1000) / 1000 - 0.5) * 5; // -2.5..2.5deg

export const charW = (size: number) => size * 0.52;
export const textW = (t: MarkText) => t.text.length * charW(t.size);

function toPaths(drawable: ReturnType<typeof gen.rectangle>, dash?: string): MarkPath[] {
  return gen.toPaths(drawable).map((p) => ({
    d: p.d,
    stroke: p.stroke,
    width: p.strokeWidth,
    fill: p.fill && p.fill !== "none" ? p.fill : undefined,
    dash: p.stroke === "none" ? undefined : dash,
  }));
}

function fillPaths(drawable: ReturnType<typeof gen.rectangle>): MarkPath[] {
  // roughjs emits the hachure as a stroked path whose stroke == fill colour
  return toPaths(drawable).map((p, i) => ({ ...p, faint: i === 0 }));
}

function arrow(from: [number, number], to: [number, number], o: object): MarkPath[] {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const bend = Math.min(80, len * 0.25);
  const mid: [number, number] = [(x1 + x2) / 2 - (dy / len) * bend, (y1 + y2) / 2 + (dx / len) * bend];
  const ang = Math.atan2(y2 - mid[1], x2 - mid[0]);
  const head = (s: number): [number, number] => [x2 - 20 * Math.cos(ang + s), y2 - 20 * Math.sin(ang + s)];
  return [
    ...toPaths(gen.curve([from, mid, to], o)),
    ...toPaths(gen.linearPath([head(0.45), to, head(-0.45)], o)),
  ];
}

const center = (b: Box): [number, number] => [b.x + b.w / 2, b.y + b.h / 2];

// nearest point on a box edge toward p
function edgeToward(b: Box, p: [number, number]): [number, number] {
  const [cx, cy] = center(b);
  const dx = p[0] - cx;
  const dy = p[1] - cy;
  const sx = dx === 0 ? Infinity : b.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : b.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy, 1);
  return [cx + dx * s, cy + dy * s];
}

// k scales text (and a little stroke) so labels stay legible when the sketch is shown small.
export function buildMark(a: Annotation, W: number, H: number, k = 1): Mark {
  const seed = seedOf(a.id);
  const { color } = kindMeta(a.kind);
  const o = { seed, roughness: 1.6, bowing: 1.4, stroke: color, strokeWidth: 3.5 * Math.min(2, Math.sqrt(k)), disableMultiStroke: false };
  const b = a.box;
  const rot = tilt(seed);
  const size = 26;
  const paths: MarkPath[] = [];
  const texts: MarkText[] = [];
  // position is decided later (buildMarks) around `bx`
  const say = (t: string, bx: Box = b, s = size, c = color) =>
    t && texts.push({ x: bx.x, y: bx.y, anchor: bx, backed: true, text: t, size: Math.round(s * k), color: c, rot });

  switch (a.kind) {
    case "insert": {
      paths.push(...fillPaths(gen.rectangle(b.x, b.y, b.w, b.h, { ...o, fill: color, fillStyle: "hachure", hachureGap: 18, fillWeight: 1.2, hachureAngle: -41 })));
      const r = 17;
      const cx = b.x + 4;
      const cy = b.y + 4;
      paths.push(...toPaths(gen.circle(cx, cy, r * 2, { ...o, fill: "#ffffff", fillStyle: "solid" })));
      paths.push(...toPaths(gen.line(cx - 8, cy, cx + 8, cy, o)), ...toPaths(gen.line(cx, cy - 8, cx, cy + 8, o)));
      say(a.label);
      break;
    }
    case "remove": {
      paths.push(...toPaths(gen.rectangle(b.x, b.y, b.w, b.h, o)));
      paths.push(...toPaths(gen.line(b.x, b.y, b.x + b.w, b.y + b.h, o)), ...toPaths(gen.line(b.x + b.w, b.y, b.x, b.y + b.h, o)));
      say(a.label);
      break;
    }
    case "move": {
      paths.push(...toPaths(gen.rectangle(b.x, b.y, b.w, b.h, o)));
      const to = a.to ?? { ...b, y: Math.min(H - b.h, b.y + b.h + 60) };
      paths.push(...toPaths(gen.rectangle(to.x, to.y, to.w, to.h, { ...o, strokeWidth: 2.5 }), "10 9"));
      const start = edgeToward(b, center(to));
      const end = edgeToward(to, center(b));
      paths.push(...arrow(start, end, o));
      say(a.label);
      break;
    }
    case "change-text": {
      const y = b.y + b.h / 2;
      paths.push(...toPaths(gen.line(b.x - 4, y, b.x + b.w + 4, y + 2, { ...o, strokeWidth: 4 })));
      // caret under the struck text, new copy above it
      const cx = b.x + Math.min(b.w / 2, 40);
      paths.push(...toPaths(gen.linearPath([[cx - 10, b.y + b.h + 12], [cx, b.y + b.h - 2], [cx + 10, b.y + b.h + 12]], o)));
      say(a.newText || a.label, b, 30);
      // the label is a footnote to the new copy; skip it when it just repeats it
      if (a.newText && a.label && !a.label.includes(a.newText)) say(a.label, b, 20, "#181818");
      break;
    }
    case "restyle": {
      const [cx, cy] = center(b);
      paths.push(...toPaths(gen.ellipse(cx, cy, b.w * 1.12 + 28, b.h * 1.3 + 28, o), "12 9"));
      say(a.label, pad(b, Math.max(14, b.h * 0.15)));
      break;
    }
    case "note": {
      paths.push(...toPaths(gen.rectangle(b.x, b.y, b.w, b.h, { ...o, strokeWidth: 2 }), "4 7"));
      const px = Math.min(W - 20, b.x + b.w);
      const py = b.y;
      paths.push(...toPaths(gen.circle(px, py, 30, { ...o, fill: "#e7a3ff", fillStyle: "solid" })));
      texts.push({ x: px - 5, y: py + 8, text: "?", size: 22, color, rot: 0 });
      say(a.label);
      break;
    }
  }
  return { paths, texts };
}

const pad = (b: Box, n: number): Box => ({ x: b.x - n, y: b.y - n, w: b.w + 2 * n, h: b.h + 2 * n });
const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

// Label slots around a box, in preference order: above, below, right, left (both alignments), then inside.
function slots(A: Box, w: number, s: number): Box[] {
  const g = 10;
  const h = s * 1.25;
  return [
    { x: A.x, y: A.y - g - h, w, h },
    { x: A.x, y: A.y + A.h + g, w, h },
    { x: A.x + A.w + g + 4, y: A.y, w, h },
    { x: A.x - w - g - 4, y: A.y, w, h },
    { x: A.x + A.w - w, y: A.y - g - h, w, h },
    { x: A.x + A.w - w, y: A.y + A.h + g, w, h },
    { x: A.x + A.w + g + 4, y: A.y + A.h - h, w, h },
    { x: A.x + 8, y: A.y + 8, w, h },
  ];
}

// All marks for a sketch. Each label goes to the free-est slot around its box: off other labels,
// off every mark's box (so it never hides what's being changed), and off the page's own text where possible.
export function buildMarks(
  anns: Annotation[],
  W: number,
  H: number,
  opts: { textScale?: number; obstacles?: Box[]; view?: Box } = {},
): Mark[] {
  const k = opts.textScale ?? 1;
  const V = opts.view ?? { x: 0, y: 0, w: W, h: H }; // visible region: labels stay inside it
  const placed: Box[] = [];
  const boxes = anns.flatMap((a) => (a.to ? [a.box, a.to] : [a.box]));
  const obstacles = opts.obstacles ?? [];
  const sum = (r: Box, list: Box[]) => list.reduce((acc, q) => acc + overlap(r, q), 0);
  return anns.map((a) => {
    const mark = buildMark(a, W, H, k);
    mark.texts = mark.texts.map((t) => {
      if (!t.anchor) return t;
      const w = textW(t) + 12;
      let best: Box | null = null;
      let bestScore = Infinity;
      slots(t.anchor, w, t.size).forEach((c, i) => {
        const r = { ...c, x: Math.max(V.x + 6, Math.min(V.x + V.w - w - 6, c.x)) };
        const out = r.y < V.y + 2 || r.y + r.h > V.y + V.h - 2 ? 1e9 : 0;
        const score =
          out + sum(r, placed) * 30 + sum(r, boxes) * 4 + sum(r, obstacles) + (r.x !== c.x ? r.w * r.h * 0.3 : 0) + i * 40;
        if (score < bestScore) [best, bestScore] = [r, score];
      });
      const r = best ?? { x: t.x, y: t.y, w, h: t.size * 1.25 };
      placed.push(r);
      return { ...t, x: r.x + 6, y: r.y + t.size * 0.98 };
    });
    return mark;
  });
}
