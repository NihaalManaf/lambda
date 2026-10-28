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
