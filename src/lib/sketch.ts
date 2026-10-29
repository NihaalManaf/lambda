import "server-only";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { featurePrompt, generate } from "./llm";
import { clamp, pad, placeInsert, placeMove } from "./placement";
import { SHOTS_DIR, id } from "./store";
import { featureMode, type Annotation, type Box, type FeatureView, type Mockup } from "./types";

// Plan marker annotations over a real screenshot. The model points at numbered DOM boxes;
// we turn idx -> pixel boxes here. Raw model coordinates are a last resort.

const Pos = z.enum(["above", "below", "left", "right", "inside", "over"]);

const Plan = z.object({
  annotations: z
    .array(
      z.object({
        kind: z.enum(["insert", "remove", "move", "change-text", "restyle", "note"]),
        label: z.string().describe("<= 6 words, marker handwriting, lowercase"),
        detail: z.string().nullable().describe("<= 20 words, only if the label is not enough"),
        idx: z.number().int().nullable().describe("element number the change targets / anchors on"),
        position: Pos.describe("insert: where the new thing goes relative to idx. others: over"),
        toIdx: z.number().int().nullable().describe("move only: destination anchor element"),
        toPosition: Pos.nullable().describe("move only: where relative to toIdx"),
        newText: z.string().nullable().describe("change-text only: the replacement copy"),
        box: z
          .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
          .nullable()
          .describe("ONLY when no element fits: page-pixel box"),
      }),
    )
    .describe("3-8 annotations; fewer is better"),
});

const SYSTEM = `
You mark up a screenshot of the developer's REAL running web app with a sharpie, to scope a feature.
Not a redesign. Show only WHERE things change:
- insert: new ui goes here (idx = anchor, position = above/below/left/right/inside)
- remove: this element goes away
- move: idx moves to toIdx/toPosition
- change-text: copy changes (newText = the new copy, short)
- restyle: same thing, different look
- note: a question / edge case pinned to an element
Point at the numbered boxes drawn on the image. Labels <= 6 words.
Elements marked (floating) are fixed overlays (fab, chat bubble, toast) sitting on top of the page: never anchor an
insert or move on one. To change a floating control itself, use restyle / change-text / note on it. Never annotate unrelated areas.
Never quote data values from the page (names, emails, numbers) in labels or details.
`.trim();

// understand: explain the existing ui, never change it. only notes survive (coerced below).
const SYSTEM_UNDERSTAND = `
You annotate a screenshot of the developer's REAL running web app with a sharpie, to explain an EXISTING feature.
Use ONLY kind "note": pin one on each element that belongs to the feature —
label = what it does / what it triggers (<= 6 words); detail = where it's handled (route / component) only if known.
Point at the numbered boxes drawn on the image. Never annotate unrelated areas.
Elements marked (floating) are fixed overlays (fab, chat bubble, toast); note them only if they belong to the feature.
Never quote data values from the page (names, emails, numbers) in labels or details.
`.trim();

export type SketchMockup = Mockup & { intent?: string; thumb?: string };

const words = (s: string, n: number) => s.trim().split(/\s+/).slice(0, n).join(" ");

// Same change marked twice: same kind, and same label on overlapping boxes or near-identical boxes.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function iou(a: Box, b: Box) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const i = ix * iy;
  return i / (a.w * a.h + b.w * b.h - i || 1);
}
const isDup = (x: Annotation, y: Annotation) =>
  x.kind === y.kind && ((norm(x.label) === norm(y.label) && iou(x.box, y.box) > 0) || iou(x.box, y.box) > 0.6);

// opts.context: facts the marker must not guess (route status, signed-out capture, new-screen rules).
export async function planSketch(
  feature: FeatureView,
  mockup: Mockup,
  intent: string,
  opts: { signal?: AbortSignal; context?: string } = {},
): Promise<Annotation[]> {
  const els = mockup.elements;
  const list = els
    .map((e) => `${e.idx} ${e.tag}${e.role ? `[${e.role}]` : ""}${e.floating ? " (floating)" : ""} "${e.text}" @${e.x},${e.y} ${e.w}x${e.h}`)
    .join("\n");

  const tiles = await markedTiles(mockup);
  const understand = featureMode(feature) === "understand";
  const prompt = `${featurePrompt(feature)}

${understand ? "what this screen shows of the feature" : "what changes on this screen"}: ${intent || "(infer from the feature)"}${opts.context ? `\n${opts.context}` : ""}

page: ${mockup.title} — ${mockup.url}
screenshot: ${mockup.width}x${mockup.height}px, sent as ${tiles.length} vertical tile(s) top→bottom${
    tiles.length > 1 ? ` (${tiles.map((t) => `y ${t.top}-${t.top + t.h}`).join(", ")})` : ""
  }. red numbered boxes = elements below.

elements (idx tag "text" @x,y wxh):
${list || "(none found — use box)"}`;

  const plan = await generate({
    schema: Plan,
    system: understand ? SYSTEM_UNDERSTAND : SYSTEM,
    prompt,
    images: tiles.map(({ mediaType, base64 }) => ({ mediaType, base64 })),
    effort: "medium",
    signal: opts.signal,
    mode: featureMode(feature),
  });
  // understand never proposes ui: anything but a note becomes a note on the same element
  if (understand) for (const a of plan.annotations) if (a.kind !== "note") Object.assign(a, { kind: "note", position: "over", toIdx: null, newText: null });

  const byIdx = new Map(els.map((e) => [e.idx, e]));
  const bounds = { w: mockup.width, h: mockup.height };
  const flow = els.filter((e) => !e.floating); // what new ui has to fit between
  const out: Annotation[] = [];
  for (const a of plan.annotations.slice(0, 10)) {
    const el = a.idx != null ? byIdx.get(a.idx) : undefined;
    let box: Box | undefined;
    // an insert on a floating widget would land on whatever is under it: mark the widget itself
    if (el) box = a.kind === "insert" && !el.floating ? placeInsert(el, a.position, bounds, flow) : pad(el, 4, bounds);
    else if (a.box) box = clamp(a.box, bounds);
    if (!box) continue;

    const ann: Annotation = { id: id("an"), kind: a.kind, box, label: words(a.label, 6) };
    if (a.detail) ann.detail = words(a.detail, 20);
    if (a.kind === "change-text" && a.newText) ann.newText = a.newText.slice(0, 80);
    if (a.kind === "move") {
      const to = a.toIdx != null ? byIdx.get(a.toIdx) : undefined;
      ann.to = to ? placeMove(to, a.toPosition ?? "below", bounds, box) : clamp({ ...box, y: box.y + box.h + 40 }, bounds);
    }
    if (out.some((o) => isDup(o, ann))) continue;
    out.push(ann);
  }
  return out;
}

// ---------- model image: screenshot + numbered boxes ("set of marks"), cut into tiles ----------

const TILE_H = 1400;

type Tile = { top: number; h: number; mediaType: "image/png" | "image/jpeg"; base64: string };

async function markedTiles(m: Mockup): Promise<Tile[]> {
  const file = path.join(SHOTS_DIR, m.shot);
  try {
    const sharp = (await import("sharp")).default;
    const marks = m.elements
      .map(
        (e) =>
          `<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" fill="none" stroke="#e2382b" stroke-width="1.5" opacity=".7"/>` +
          `<rect x="${e.x}" y="${Math.max(0, e.y - 15)}" width="${String(e.idx).length * 8 + 6}" height="15" fill="#e2382b"/>` +
          `<text x="${e.x + 3}" y="${Math.max(0, e.y - 15) + 12}" font-family="monospace" font-size="12" fill="#fff">${e.idx}</text>`,
      )
      .join("");
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${m.width}" height="${m.height}">${marks}</svg>`);
    const marked = await sharp(file)
      .composite([{ input: svg, top: 0, left: 0 }])
      .png()
      .toBuffer();
    const tiles: Tile[] = [];
    for (let top = 0; top < m.height && tiles.length < 3; top += TILE_H) {
      const h = Math.min(TILE_H, m.height - top);
      // jpeg keeps each tile well under the API's 5MB image cap
      const buf = await sharp(marked).extract({ left: 0, top, width: m.width, height: h }).jpeg({ quality: 82 }).toBuffer();
      tiles.push({ top, h, mediaType: "image/jpeg" as const, base64: buf.toString("base64") });
    }
    return tiles;
  } catch {
    // no sharp: raw screenshot, the API downsamples
    return [{ top: 0, h: m.height, mediaType: "image/png", base64: fs.readFileSync(file).toString("base64") }];
  }
}
