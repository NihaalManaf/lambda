"use client";

import StopMotion, { rand, spawn, type Cue, type LoaderProps, type Scene } from "@/components/StopMotion";

// A marble sculptor chiselling a block, as a stop-motion loop. Three baked frames (identical crop; one shared block
// layer composited into all three and tone-matched, so only the figure changes); at impact a few marble chips spit
// off the chisel tip.
// Shown on generating states that build structure (schema, queues, sources): the work is being carved, not loaded.

// chisel tip in the 720x598 frames (strike frame)
const TIP = { x: 0.642, y: 0.485 };
// chips stay inside the art palette: ivory / paper / stone grey
const CHIP = ["#ebe7de", "#d6d0c4", "#c2bcb0", "#aaa499", "#948e83", "#7f7a70"];

function impact({ box, art, fx, s }: Cue) {
  const ox = TIP.x * box.clientWidth;
  const oy = TIP.y * box.clientHeight;

  // whole-image micro jolt (the block is baked into the frames, so it never moves on its own)
  art.animate(
    [
      { transform: "translate(0,0)" },
      { transform: `translate(${0.8 * Math.min(s, 1.2)}px, 0.4px)` },
      { transform: "translate(0,0)" },
    ],
    { duration: 60, easing: "linear" },
  );

  // dust puff
  const pr = 26 * s;
  spawn(
    fx,
    {
      left: `${ox - pr}px`,
      top: `${oy - pr}px`,
      width: `${pr * 2}px`,
      height: `${pr * 2}px`,
      borderRadius: "9999px",
      background: "radial-gradient(closest-side, rgba(190,184,173,0.5), rgba(214,209,199,0.22) 55%, transparent 100%)",
    },
    [
      { transform: "translate(0,0) scale(0.35)", opacity: 0 },
      { transform: `translate(${-6 * s}px, ${-2 * s}px) scale(0.9)`, opacity: 0.9, offset: 0.2 },
      { transform: `translate(${-14 * s}px, ${4 * s}px) scale(1.7)`, opacity: 0 },
    ],
    { duration: rand(560, 680), easing: "cubic-bezier(0.22,1,0.36,1)" },
  );

  // chips: up-and-out away from the block face (leftward), then gravity
  const n = Math.round(rand(5, 9));
  for (let i = 0; i < n; i++) {
    const sz = rand(3.5, 6.5) * Math.max(s, 0.6);
    const pts = Array.from({ length: 5 }, (_, k) => {
      const ang = (k / 5) * Math.PI * 2 + rand(-0.4, 0.4);
      const r = rand(32, 50);
      return `${50 + Math.cos(ang) * r}% ${50 + Math.sin(ang) * r}%`;
    }).join(",");
    // launch angle: up and back toward the sculptor, so chips visibly kick off the chisel before gravity wins
    const ang = rand((110 / 180) * Math.PI, (170 / 180) * Math.PI); // measured from +x, y up
    const v = rand(90, 150) * s; // px/s-ish initial speed
    const vx = Math.cos(ang) * v;
    const vy = Math.sin(ang) * v;
    const g = 340 * s;
    const dur = rand(450, 700);
    const T = dur / 1000;
    const spin = rand(-260, 260);
    const kf: Keyframe[] = [];
    const N = 9;
    for (let k = 0; k <= N; k++) {
      const t = (k / N) * T;
      const x = vx * t;
      const y = -(vy * t) + 0.5 * g * t * t;
      kf.push({
        transform: `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${((spin * k) / N).toFixed(1)}deg)`,
        opacity: k / N < 0.55 ? 1 : Math.max(0, 1 - (k / N - 0.55) / 0.45),
      });
    }
    spawn(
      fx,
      {
        left: `${ox - sz / 2}px`,
        top: `${oy - sz / 2}px`,
        width: `${sz}px`,
        height: `${sz * rand(0.6, 1)}px`,
        background: CHIP[Math.floor(Math.random() * CHIP.length)],
        clipPath: `polygon(${pts})`,
        willChange: "transform, opacity",
      },
      kf,
      { duration: dur, easing: "linear" },
    );
  }
}

const SCENE: Scene<"raised" | "mid" | "strike"> = {
  dir: "/art/sculptor",
  frames: ["raised", "mid", "strike"],
  size: [720, 598],
  // one blow: raised hold -> mid (downswing) -> strike (impact, held so the blow lands) -> mid (quick recoil)
  // -> raised. durations vary a touch per blow.
  seq: () => [
    ["raised", rand(900, 1200)],
    ["mid", rand(70, 90)],
    ["strike", rand(170, 210)],
    ["mid", 60],
  ],
  cue: { strike: impact },
};

export default function Sculptor(props: LoaderProps) {
  return <StopMotion scene={SCENE} {...props} />;
}
