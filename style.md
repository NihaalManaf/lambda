# lambda — style

Theme lifted from livetheresidency.com. Editorial, classical, quiet. Tokens live in `src/app/globals.css`; this file is the why + the rules.

## Voice

- lowercase everywhere (headlines, nav, buttons, eyebrows).
- one line per idea. if it needs a paragraph, it isn't ready.
- emphasis = serif *italic* or an `.outlined` word. never bold for emphasis in display type.
- no slop: no filler copy, no decorative emoji, no gradients-for-the-sake-of-it.

## Colour

| token | value | use |
|---|---|---|
| `--paper` | `#f8f8f6` | page background (warm off-white) |
| `--paper-2` | `#f0efeb` | recessed surfaces, shimmer base |
| `--card` | `#ffffff` | cards, inputs |
| `--ink` | `#181818` | text, primary button ("nero") |
| `--ink-2` | `#3a3a3a` | secondary text |
| `--grey` | `#727272` | eyebrows, meta, numbering |
| `--line` / `--line-2` | `#e4e2dc` / `#d3d0c8` | hairlines, borders |
| `--lilac` | `#e7a3ff` | the one accent: selection, focus ring, highlight |
| `--lilac-soft` | `#f6e4ff` | haze behind hero art |
| `--blue` | `#096ad0` | links / info only |
| `--ok` `--warn` `--bad` | `#2f8f5b` `#c98a12` `#d4462f` | status only |
| `--marker*` | red / blue / green | sharpie annotations on UI sketches only |

Rule: ink on paper first. Lilac is spice — one lilac thing per view.

## Type

- **display** — STIX Two Text (`.display`): weight 400, tracking `-0.02em`, line-height `0.95`. headlines, tenets, big numbers.
- **body / UI** — Manrope (`font-sans`).
- **meta** — Inconsolata (`font-mono`). `.eyebrow` = 11px, uppercase, `0.14em` tracking, grey. section labels, numbering (`01`, `02`).
- **hand** — Kalam (`font-hand`). marker sketches only.
- sizes fluid via `clamp()` — hero `clamp(2.5rem,5.4vw,5.5rem)`, tenets `clamp(1.75rem,3.6vw,3rem)`.

## Shape

- buttons, chips: pill (`rounded-full`). `.btn-primary` ink, `.btn-ghost` hairline, `.btn-lilac` accent.
- cards: `.card` — white, 1px `--line`, radius 18px.
- inputs: radius 12px, focus = ink border + 3px lilac ring.
- dividers: hairline `border-line`, lists as `divide-y` between `border-y`.
- layout max width `max-w-7xl`, gutter `px-6`.

## Imagery

Classical marble / stone sculpture, photoreal, transparent cutout, floating on paper. Each piece pairs antiquity with one modern or tool element (astronaut helmet, compass, stylus, tablet, headphones, circuitry).

- materials: ivory marble (warm, fine cracks) or graphite stone (cool grey). soft studio light from upper left, no hard shadows, no background, no ground plane.
- palette stays inside paper / ivory / grey — art never introduces colour; lilac comes from css haze behind it.
- edges dissolve into the paper: `.statue-fade`, `.fade-b`, `.fade-br` masks. never a hard crop line.
- blend, don't sticker: `mix-blend-mode: multiply` + top/bottom mask fade, a soft stone/lilac haze behind, and hairlines that run behind the art so type and stone share one surface.
- decorative only: `alt=""` + `aria-hidden`, `pointer-events-none`.
- files: `public/art/*.webp`, ~900px wide, transparent. pillar: `pillar-laurel.webp` (ivory ionic column, marble laurel + ivy), flanks the manifesto, right copy mirrored.
- in layout, statues float (zero-height cells) and never push content.

## Loaders

Working states are statues at work, not spinners. Each loader is a few baked frames of one generated scene, hard-cut like stop-motion, so it reads as the art come alive.

| loader | scene | shown when | file |
|---|---|---|---|
| sculptor | graphite sculptor chiselling an ivory block | building structure (schema, queues, sources) | `Sculptor.tsx`, `public/art/sculptor/` |
| painter | painter at a marble easel | drawing (flows, mockups) | `Painter.tsx`, `public/art/painter/` |
| scribe | scribe writing on a marble scroll | writing (stories, the brief) | `Scribe.tsx`, `public/art/scribe/` |
| globe | ivory globe turning on an ionic pedestal | compact "an agent is working" (feature cards, pills) | `Globe.tsx`, `public/art/globe/spin.webp` |
| evolution | march of progress frieze, ape → man with a laptop, graphite → ivory | lambda working in the ask bar | `Evolution.tsx`, `public/art/march/` |

Making a new one (scripts in `scripts/art/`, key in `OPENAI_API_KEY`):

1. **base frame** — `gen.py` with `gpt-image-1.5` on `/v1/images/edits`, an existing art file (e.g. `public/art/sculptor/raised.webp` flattened on white) as the reference, `input_fidelity: low`, transparent background, 1536×1024. Generate 2 and pick. Prompt = the style lock + the scene:
   > Match the rendering style, lighting, scale and stone materials of the attached reference exactly (photoreal 3D render of classical sculpture: graphite-grey stone figure, rough ivory marble, soft diffused studio light from upper left, no hard shadows). Fully transparent background, no floor, no ground plane, no shadow plate, no text, no frame, no colour anywhere: only greys and ivory. Whole scene visible, nothing cropped, generous empty margin all around.

   then the scene: figure in side profile FACING RIGHT, the tool and what it's working on, and the pose of this frame in CAPS (e.g. "The mallet is RAISED high behind his head").
2. **pose frames** — edit the chosen base with `input_fidelity: high`:
   > Edit this exact image. Keep EVERYTHING identical and pixel-aligned: same [figure], same pose of body, head, legs and left arm, same [props]; nothing moves or resizes except his right forearm, hand and [tool]. Same framing, lighting and scale. ONLY change: …

   Say where the tool tip lands relative to something fixed ("directly below the chin of the painted face"). Generate 2–3 per pose and pick.
3. **composite** — `comp.cjs spec.json`: every frame is the base everywhere except feathered polygons around the moving limb (plus an auto mask wherever coverage changed), so props never drift between cuts. `keep` rects pin props the edit dropped. Chroma is capped (16–24) so edits can't tint anything brown. Output: one crop, 720px wide webp per frame.
4. **wire it** — a `Scene` for `StopMotion.tsx` (frames, timings, a cue at the tool tip for the small css effect: chips, wash, ink). Tool-tip coords are measured in the 720px frames.

Friezes (evolution): one still of separate figures with a clear gap between each, then `split.py still.png out_dir` cuts one webp per figure on a shared ground line and prints their [left, width]; light them in a staggered css wave. The safety filter misreads unclothed statues as nudity — cover every figure ("carved stone fur", "animal-hide wrap", "draped chiton", "a museum display suitable for all ages").

Things that turn instead of pose (the globe): generate the still (object on a pedestal, sphere seen straight on, nothing in front of it) and a flat texture in the same material (`opaque: true`, "flat equirectangular … carved in marble, evenly lit, no shading"), then `spin.py still.png texture.png out.webp 24 240 2.4` projects the texture onto the still's sphere, shades it with the still's own light, and writes one strip of frames. Play it with css `steps(n)`. Contrast ~2.4, or the carving vanishes below 60px.

## Motion

Motion library: `motion/react`. Butter, never bounce for its own sake.

- easing: `--ease-out` `cubic-bezier(0.22,1,0.36,1)` for css; `--ease-spring` for playful pops.
- UI springs (snappy): `stiffness 420–520, damping 34–40`.
- entrance springs: `stiffness 120–160, damping 20–22`, rise `y: 16–24`, stagger `0.05s`.
- art springs (heavy, slow): `stiffness 70–80, damping 18–20`; idle drift `y ±8px`, `rotate ±1°`, 8–11s loops; scroll parallax ≤ 60px.
- press: `scale(0.97)`. hover: ≤ 6px nudge.
- `whileInView` with `once: true`. initial state identical on server + client.
- reduced motion: global css kill-switch + `useReducedMotion()` to drop loops/parallax.

## Don'ts

- walls of text, centred paragraphs, more than one accent colour per view.
- drop shadows on art, rounded corners on art, borders on art.
- port 3000 (reserved for another app).
