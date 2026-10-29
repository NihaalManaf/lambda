"use client";

import StopMotion, { rand, spawn, type Cue, type LoaderProps, type Scene } from "@/components/StopMotion";

// A stone scribe at a marble desk, as a stop-motion loop. Three baked frames (identical crop; one shared desk + scroll
// layer composited into all three, so only the figure changes): pen dipping in the inkwell, pen down at the start of
// a line, hand slid along it. Each pass inks a short line on the scroll that slowly fades.
// Shown on generating states that write (stories, the brief): the words are being set down, not loaded.

// pen tip in the 720x598 frames: start of a line (down) and end of it (across)
const DOWN = { x: 0.559, y: 0.451 };
const ACROSS = { x: 0.622, y: 0.463 };
// lines step down the scroll, then wrap back to the top
const LINES = 4;
const LEAD = 0.022; // line spacing as a fraction of box height
const INK = "rgba(58,56,53,0.7)";

let line = 0;

function dot({ box, fx, s }: Cue) {
  const r = 1.4 * Math.max(s, 0.6);
  spawn(
    fx,
    {
      left: `${DOWN.x * box.clientWidth - r}px`,
      top: `${(DOWN.y + line * LEAD) * box.clientHeight - r}px`,
      width: `${r * 2}px`,
      height: `${r * 2}px`,
      borderRadius: "9999px",
      background: INK,
      mixBlendMode: "multiply",
    },
    [{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }],
    { duration: 1400, easing: "linear" },
  );
}

function ink({ box, fx, s }: Cue) {
  const w = box.clientWidth;
  const h = box.clientHeight;
  const x0 = DOWN.x * w;
  const y0 = (DOWN.y + line * LEAD) * h;
  const dx = (ACROSS.x - DOWN.x) * w * rand(0.75, 1);
  const dy = (ACROSS.y - DOWN.y) * h;
  const th = Math.max(1, 1.1 * s);
  // script, not a rule: dashed into word-length runs so it reads as handwriting at a glance
  const words = Array.from({ length: 4 }, () => rand(10, 22));
  const total = words.reduce((a, b) => a + b, 0) + 6 * words.length;
  let at = 0;
  const stops = words
    .map((ww) => {
      const a = (at / total) * 100;
      const b = ((at + ww) / total) * 100;
      at += ww + 6;
      return `#000 ${a.toFixed(1)}% ${b.toFixed(1)}%, transparent ${b.toFixed(1)}% ${((at / total) * 100).toFixed(1)}%`;
    })
    .join(", ");
  const rot = Math.atan2(dy, dx);
  spawn(
    fx,
    {
      left: `${x0}px`,
      top: `${y0 - th / 2}px`,
      width: `${Math.hypot(dx, dy)}px`,
      height: `${th}px`,
      borderRadius: `${th}px`,
      background: INK,
      maskImage: `linear-gradient(90deg, ${stops})`,
      transformOrigin: "0 50%",
      mixBlendMode: "multiply",
      willChange: "transform, opacity",
    },
    [
      { transform: `rotate(${rot}rad) scaleX(0)`, opacity: 1 },
      { transform: `rotate(${rot}rad) scaleX(1)`, opacity: 1, offset: 0.15 },
      { transform: `rotate(${rot}rad) scaleX(1)`, opacity: 0.8, offset: 0.6 },
      { transform: `rotate(${rot}rad) scaleX(1)`, opacity: 0 },
    ],
    { duration: rand(2200, 2600), easing: "cubic-bezier(0.22,1,0.36,1)" },
  );
  line = (line + 1) % LINES;
}

const SCENE: Scene<"lifted" | "down" | "across"> = {
  dir: "/art/scribe",
  frames: ["lifted", "down", "across"],
  size: [720, 598],
  // one line: lifted (dip, read back) -> down (nib lands) -> across (held while the line inks) -> lifted.
  // the steadiest of the three: writing is a rhythm, not a blow.
  seq: () => [
    ["lifted", rand(800, 1100)],
    ["down", rand(140, 180)],
    ["across", rand(420, 520)],
  ],
  cue: { down: dot, across: ink },
};

export default function Scribe(props: LoaderProps) {
  return <StopMotion scene={SCENE} {...props} />;
}
