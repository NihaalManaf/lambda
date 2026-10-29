import { describe, expect, it } from "vitest";
import { placeInsert, placeMove, room } from "./placement";
import type { Box } from "./types";

const page = { w: 1280, h: 2000 };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// the campaigns page: banner, then search bar 15px under it, then the table
const banner: Box = { x: 360, y: 640, w: 1150, h: 60 };
const search: Box = { x: 360, y: 715, w: 440, h: 45 };
const table: Box = { x: 360, y: 780, w: 1150, h: 900 };
const main: Box = { x: 340, y: 0, w: 1200, h: 2000 }; // wraps everything: never "in the way"

describe("room", () => {
  it("measures to the nearest element on that side, ignoring wrappers", () => {
    const els = [main, banner, search, table];
    expect(room(search, "above", els, page)).toBe(15);
    expect(room(search, "below", els, page)).toBe(20);
    expect(room(banner, "above", els, page)).toBe(640);
  });
});

describe("placeInsert", () => {
  it("squeezed between elements: a thin seam strip, not a box over the banner", () => {
    const b = placeInsert(search, "above", page, [main, banner, search, table]);
    expect(b.h).toBe(28);
    expect(Math.abs(b.y + b.h / 2 - 707.5)).toBeLessThanOrEqual(1);
    expect(overlaps(b, { ...banner, h: banner.h - 8 })).toBe(false);
  });

  it("uses the open space when there is some", () => {
    const hero: Box = { x: 360, y: 200, w: 600, h: 80 };
    const card: Box = { x: 360, y: 500, w: 1150, h: 120 };
    const b = placeInsert(hero, "below", page, [hero, card]);
    expect(b.y).toBe(294);
    expect(b.y + b.h).toBeLessThanOrEqual(card.y);
    expect(b.w).toBe(hero.w);
  });

  it("flips left/right when one side is the page edge, else drops below", () => {
    const edge: Box = { x: 1180, y: 100, w: 90, h: 40 };
    const r = placeInsert(edge, "right", page, [edge]);
    expect(r.x + r.w).toBeLessThanOrEqual(edge.x);
    const wide: Box = { x: 10, y: 100, w: 1260, h: 40 };
    expect(placeInsert(wide, "right", page, [wide]).y).toBeGreaterThan(wide.y + wide.h);
  });

  it("inside: after the last child when there's space", () => {
    const panel: Box = { x: 100, y: 100, w: 600, h: 400 };
    const kids: Box[] = [
      { x: 120, y: 120, w: 300, h: 40 },
      { x: 120, y: 180, w: 500, h: 40 },
    ];
    const b = placeInsert(panel, "inside", page, [panel, ...kids]);
    expect(b.y).toBeGreaterThanOrEqual(220);
    expect(kids.some((k) => overlaps(b, k))).toBe(false);
    expect(b.y + b.h).toBeLessThanOrEqual(panel.y + panel.h);
  });
});

describe("placeMove", () => {
  it("keeps the moved size and flips off the page edge", () => {
    const anchor: Box = { x: 1100, y: 300, w: 150, h: 40 };
    const size: Box = { x: 0, y: 0, w: 200, h: 50 };
    const b = placeMove(anchor, "right", page, size);
    expect(b.w).toBe(200);
    expect(b.x + b.w).toBeLessThanOrEqual(anchor.x);
  });
});
