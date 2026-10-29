"use client";

import StopMotion, { rand, spawn, type Cue, type LoaderProps, type Scene } from "@/components/StopMotion";

// A stone painter at a marble easel, as a stop-motion loop. Three baked frames (identical crop; one shared easel
// layer composited into all three, so only the figure changes): brush lifted, brush at the mouth of the half-painted face,
// brush dragged down under the chin. The drag lays a grey wash stroke that dries away; the touch leaves a small dab.
// Shown on generating states that draw (flows, mockups): the picture is being painted, not loaded.

// brush tip in the 720x598 frames: where it lands (touch) and where the drag ends
const TOUCH = { x: 0.739, y: 0.481 };
const DRAG = { x: 0.766, y: 0.511 };
// wash stays inside the art palette: graphite greys, multiplied onto paper
const WASH = ["rgba(72,70,66,0.32)", "rgba(96,93,88,0.28)", "rgba(120,116,110,0.26)"];

function dab({ box, fx, s }: Cue) {
  const r = rand(3, 4.5) * Math.max(s, 0.6);
  spawn(
    fx,
    {
      left: `${TOUCH.x * box.clientWidth - r}px`,
      top: `${TOUCH.y * box.clientHeight - r}px`,
      width: `${r * 2}px`,
      height: `${r * 2}px`,
      borderRadius: "9999px",
      background: WASH[0],
      mixBlendMode: "multiply",
    },
    [
      { transform: "scale(0.4)", opacity: 0 },
      { transform: "scale(1)", opacity: 1, offset: 0.15 },
      { transform: "scale(1.1)", opacity: 0 },
    ],
    { duration: rand(700, 900), easing: "cubic-bezier(0.22,1,0.36,1)" },
  );
}

function stroke({ box, fx, s }: Cue) {
  const w = box.clientWidth;
  const h = box.clientHeight;
  const x0 = TOUCH.x * w;
  const y0 = TOUCH.y * h;
  const dx = DRAG.x * w - x0 + rand(-3, 3) * s;
  const dy = DRAG.y * h - y0 + rand(-3, 3) * s;
  const len = Math.hypot(dx, dy);
  const th = rand(3.5, 5.5) * Math.max(s, 0.6);
  // a bristle-edged ribbon: thick at the landing, thinning and breaking up toward the lift
  spawn(
    fx,
    {
      left: `${x0}px`,
      top: `${y0 - th / 2}px`,
      width: `${len}px`,
      height: `${th}px`,
      borderRadius: `${th}px ${th / 3}px ${th / 3}px ${th}px`,
      background: `linear-gradient(90deg, ${WASH[Math.floor(Math.random() * WASH.length)]} 0%, ${WASH[2]} 70%, transparent 100%)`,
      maskImage: "repeating-linear-gradient(0deg, #000 0 1.2px, rgba(0,0,0,0.55) 1.2px 2px)",
      transformOrigin: "0 50%",
      mixBlendMode: "multiply",
      willChange: "transform, opacity",
    },
    [
      { transform: `rotate(${Math.atan2(dy, dx)}rad) scaleX(0)`, opacity: 1 },
      { transform: `rotate(${Math.atan2(dy, dx)}rad) scaleX(1)`, opacity: 1, offset: 0.22 },
      { transform: `rotate(${Math.atan2(dy, dx)}rad) scaleX(1)`, opacity: 0.85, offset: 0.55 },
      { transform: `rotate(${Math.atan2(dy, dx)}rad) scaleX(1)`, opacity: 0 },
    ],
    { duration: rand(1300, 1600), easing: "cubic-bezier(0.22,1,0.36,1)" },
  );
}

const SCENE: Scene<"lifted" | "touch" | "drag"> = {
  dir: "/art/painter",
  frames: ["lifted", "touch", "drag"],
  size: [720, 598],
  // one stroke: lifted hold (considering) -> touch (bristles land) -> drag (held while the wash lays down) -> touch
  // (lift-off). slower and softer than the sculptor's blow.
  seq: () => [
    ["lifted", rand(1000, 1400)],
    ["touch", rand(110, 140)],
    ["drag", rand(320, 380)],
    ["touch", 90],
  ],
  cue: { touch: dab, drag: stroke },
};

export default function Painter(props: LoaderProps) {
  return <StopMotion scene={SCENE} {...props} />;
}
