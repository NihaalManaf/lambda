import type { Box } from "./types";

// Where a marker box goes on a real screenshot. Inserts take the free space next to their anchor (up to the
// nearest element in the way) instead of a fixed-size box that lands on whatever is there.

export type Pos = "above" | "below" | "left" | "right" | "inside" | "over";
type Bounds = { w: number; h: number };

const GAP = 14;
const STRIP = 28; // no room: a thin seam marker between elements, not a box over them
const MIN_H = 40;
const MIN_W = 120;
const MAX_H = 140;
const MAX_W = 520;

export function clamp(b: Box, { w, h }: Bounds): Box {
  const x = Math.max(0, Math.min(b.x, w - 20));
  const y = Math.max(0, Math.min(b.y, h - 20));
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(Math.max(20, Math.min(b.w, w - x))),
    h: Math.round(Math.max(20, Math.min(b.h, h - y))),
  };
}

export const pad = (b: Box, p: number, bounds: Bounds) => clamp({ x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: b.h + 2 * p }, bounds);

const contains = (a: Box, b: Box, t = 2) => a.x <= b.x + t && a.y <= b.y + t && a.x + a.w >= b.x + b.w - t && a.y + a.h >= b.y + b.h - t;
const spanX = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
const spanY = (a: Box, b: Box) => Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);

// Free distance from the anchor's edge to the nearest element on that side (or the page edge).
// Wrappers of the anchor and its own children are not in the way.
export function room(anchor: Box, pos: "above" | "below" | "left" | "right", els: Box[], bounds: Bounds): number {
  const others = els.filter((e) => !contains(e, anchor) && !contains(anchor, e));
  const bottom = anchor.y + anchor.h;
  const right = anchor.x + anchor.w;
  switch (pos) {
    case "below":
      return Math.min(bounds.h, ...others.filter((e) => spanX(e, anchor) > 0 && e.y >= bottom - 2).map((e) => e.y)) - bottom;
    case "above":
      return anchor.y - Math.max(0, ...others.filter((e) => spanX(e, anchor) > 0 && e.y + e.h <= anchor.y + 2).map((e) => e.y + e.h));
    case "right":
      return Math.min(bounds.w, ...others.filter((e) => spanY(e, anchor) > 0 && e.x >= right - 2).map((e) => e.x)) - right;
    case "left":
      return anchor.x - Math.max(0, ...others.filter((e) => spanY(e, anchor) > 0 && e.x + e.w <= anchor.x + 2).map((e) => e.x + e.w));
  }
}

// New ui next to `anchor`, sized to the room actually there. `els`: the page's boxes (floating widgets excluded).
export function placeInsert(anchor: Box, pos: Pos, bounds: Bounds, els: Box[] = []): Box {
  if (pos === "over") return pad(anchor, 4, bounds);
  if (pos === "inside") return inside(anchor, bounds, els);
  if (pos === "left" || pos === "right") {
    const flip = pos === "left" ? "right" : "left";
    for (const side of [pos, flip] as const) {
      const r = room(anchor, side, els, bounds);
      if (r < MIN_W + 2 * GAP) continue;
      const w = Math.min(Math.max(anchor.w, MIN_W), MAX_W, r - 2 * GAP);
      const h = Math.min(Math.max(anchor.h, MIN_H), MAX_H);
      return clamp({ x: side === "right" ? anchor.x + anchor.w + GAP : anchor.x - GAP - w, y: anchor.y, w, h }, bounds);
    }
    return placeInsert(anchor, "below", bounds, els); // no room either side
  }
  const r = room(anchor, pos, els, bounds);
  const w = Math.min(anchor.w, bounds.w);
  if (r >= MIN_H + 2 * GAP) {
    const h = Math.min(MAX_H, Math.max(anchor.h, 56), r - 2 * GAP);
    return clamp({ x: anchor.x, y: pos === "below" ? anchor.y + anchor.h + GAP : anchor.y - GAP - h, w, h }, bounds);
  }
  // squeezed between two elements: a strip centred on the gap
  const seam = pos === "below" ? anchor.y + anchor.h + Math.max(0, r) / 2 : anchor.y - Math.max(0, r) / 2;
  return clamp({ x: anchor.x, y: seam - STRIP / 2, w, h: STRIP }, bounds);
}

// After the anchor's last child when there's space; else a strip on its bottom edge (the container grows).
function inside(anchor: Box, bounds: Bounds, els: Box[]): Box {
  const kids = els.filter((e) => contains(anchor, e) && !contains(e, anchor));
  if (!kids.length) {
    const w = anchor.w * 0.76;
    const h = Math.min(anchor.h * 0.6, 200);
    return clamp({ x: anchor.x + (anchor.w - w) / 2, y: anchor.y + (anchor.h - h) / 2, w, h }, bounds);
  }
  const last = Math.max(...kids.map((e) => e.y + e.h));
  const x0 = Math.min(...kids.map((e) => e.x));
  const x1 = Math.max(...kids.map((e) => e.x + e.w));
  const free = anchor.y + anchor.h - last;
  if (free >= MIN_H + GAP) return clamp({ x: x0, y: last + GAP / 2, w: x1 - x0, h: Math.min(MAX_H, free - GAP) }, bounds);
  return clamp({ x: x0, y: anchor.y + anchor.h - STRIP / 2, w: x1 - x0, h: STRIP }, bounds);
}

// A move target: the moved thing's size, beside `anchor`, flipped when that side is off the page.
export function placeMove(anchor: Box, pos: Pos, bounds: Bounds, size: Box): Box {
  const { w, h } = size;
  switch (pos) {
    case "above":
      return clamp({ x: anchor.x, y: anchor.y - h - GAP, w, h }, bounds);
    case "below":
      return clamp({ x: anchor.x, y: anchor.y + anchor.h + GAP, w, h }, bounds);
    case "left":
    case "right": {
      const fitsRight = anchor.x + anchor.w + GAP + w <= bounds.w;
      const fitsLeft = anchor.x - GAP - w >= 0;
      const right = pos === "right" ? fitsRight || !fitsLeft : !fitsLeft && fitsRight;
      return clamp({ x: right ? anchor.x + anchor.w + GAP : anchor.x - GAP - w, y: anchor.y, w, h }, bounds);
    }
    case "inside": {
      const iw = Math.min(w, anchor.w * 0.9);
      const ih = Math.min(h, anchor.h * 0.9);
      return clamp({ x: anchor.x + (anchor.w - iw) / 2, y: anchor.y + (anchor.h - ih) / 2, w: iw, h: ih }, bounds);
    }
    default:
      return pad(anchor, 4, bounds);
  }
}
