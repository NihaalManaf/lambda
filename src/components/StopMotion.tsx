"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useReducedMotion } from "motion/react";
import clsx from "clsx";

// Shared engine for the atelier loaders (sculptor, painter, scribe): a few baked frames of one statue at work, hard-cut
// on one timeout scheduler, with a per-frame cue for the small css/waapi effect at the tool tip (chips, wash, ink).
// Every frame shares one crop and one static layer, so the cut only ever moves the figure.

export type Cue = {
  box: HTMLDivElement; // the art box (for size)
  art: HTMLDivElement; // the frame stack (for jolts)
  fx: HTMLDivElement; // empty overlay for transient particles
  s: number; // box width / 280, to scale effects with the size prop
};

export type Scene<F extends string = string> = {
  dir: string; // /art/<name>, frames at <dir>/<frame>.webp
  frames: readonly F[]; // first frame is the rest pose, shown before decode and when paused
  size: readonly [number, number]; // intrinsic frame size
  seq: () => [F, number][]; // one beat of the loop; regenerated each beat so durations can wander
  cue?: Partial<Record<F, (c: Cue) => void>>;
};

export type LoaderProps = {
  label?: string;
  startedAt?: string | number;
  size?: keyof typeof W;
  labelAt?: "top" | "bottom"; // top keeps the status line above the fold / clear of the floating ask bar
  haze?: boolean; // lilac haze behind the art; off by default since a running job already lights a lilac tab dot
  className?: string;
};

const W = { xs: 96, sm: 160, md: 280, lg: 420 } as const;

const frameSrc = (dir: string, f: string) => `${dir}/${f}.webp`;

export const rand = (a: number, b: number) => a + Math.random() * (b - a);

// a transient absolutely-positioned div in the fx layer, removed when its animation finishes
export function spawn(host: HTMLElement, style: Partial<CSSStyleDeclaration>, kf: Keyframe[], opts: KeyframeAnimationOptions) {
  const n = document.createElement("div");
  Object.assign(n.style, { position: "absolute", pointerEvents: "none" }, style);
  host.appendChild(n);
  n.animate(kf, opts).finished.finally(() => n.remove());
  return n;
}

export default function StopMotion<F extends string>({
  scene,
  label,
  startedAt,
  size = "md",
  labelAt = "bottom",
  haze = false,
  className,
}: LoaderProps & { scene: Scene<F> }) {
  const reduce = useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const art = useRef<HTMLDivElement>(null);
  const fx = useRef<HTMLDivElement>(null);
  const frames = useRef<Partial<Record<F, HTMLDivElement | null>>>({});
  const elapsed = useElapsed(startedAt);
  const rest = scene.frames[0];

  useEffect(() => {
    const rest = scene.frames[0];
    if (reduce || !box.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = box.current;
    const layer = fx.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let step = 0;
    let visible = true;
    let running = false;

    // stop-motion: hard cuts, never a crossfade (a fade ghosts the outgoing limb through the incoming frame's
    // transparent areas).
    const show = (f: F) => {
      for (const k of scene.frames) {
        const n = frames.current[k];
        if (n) n.style.opacity = k === f ? "1" : "0";
      }
    };

    let beat = scene.seq();
    const tick = () => {
      if (!running) return;
      const [f, ms] = beat[step];
      show(f);
      const cue = scene.cue?.[f];
      if (cue && layer && art.current) cue({ box: el, art: art.current, fx: layer, s: el.clientWidth / 280 });
      step++;
      if (step >= beat.length) {
        step = 0;
        beat = scene.seq();
      }
      timer = setTimeout(tick, ms);
    };

    const sync = () => {
      const want = visible && document.visibilityState === "visible";
      if (want && !running) {
        running = true;
        tick();
      } else if (!want && running) {
        running = false;
        clearTimeout(timer);
        show(rest);
        step = 0;
      }
    };

    // hold the rest frame until every frame is decoded, so a hard cut never lands on an empty frame
    let ready = false;
    let alive = true;
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (ready) sync();
    });
    io.observe(el);
    const onVis = () => {
      if (ready) sync();
    };
    document.addEventListener("visibilitychange", onVis);
    Promise.all(
      scene.frames.map((f) => {
        const im = new window.Image();
        im.src = frameSrc(scene.dir, f);
        return im.decode().catch(() => undefined);
      }),
    ).then(() => {
      if (!alive) return;
      ready = true;
      sync();
    });
    return () => {
      alive = false;
      running = false;
      clearTimeout(timer);
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      layer?.replaceChildren();
      show(rest);
    };
  }, [reduce, scene]);

  const text = label ? `${label}${elapsed != null ? ` · ${elapsed}s` : ""}` : null;

  const caption = text && <div className={clsx("eyebrow", labelAt === "top" ? "mb-3" : "mt-3")}>{text}</div>;

  const [w, h] = scene.size;
  return (
    <div
      role={text ? "status" : undefined}
      aria-live={text ? "polite" : undefined}
      className={clsx("flex flex-col items-center", className)}
    >
      {labelAt === "top" && caption}
      <div
        ref={box}
        aria-hidden
        className="pointer-events-none relative max-w-full select-none"
        style={{ width: W[size], aspectRatio: `${w} / ${h}` }}
      >
        {/* soft stone (or opt-in lilac) haze behind the art + a stone-dust floor; never a hard shadow */}
        <div
          className="absolute -inset-[12%]"
          style={{
            background: `radial-gradient(46% 42% at 52% 46%, color-mix(in srgb, ${haze ? "var(--lilac-soft) 75%" : "var(--paper-2) 90%"}, transparent) 0%, transparent 72%)`,
          }}
        />
        <div
          className="absolute inset-x-[4%] bottom-[2%] h-[14%]"
          style={{
            background:
              "radial-gradient(50% 50% at 50% 50%, rgba(205,200,190,0.45) 0%, rgba(225,221,213,0.2) 50%, transparent 100%)",
          }}
        />
        <div ref={art} className="fade-b absolute inset-0 mix-blend-multiply">
          {scene.frames.map((f) => (
            <div
              key={f}
              ref={(n) => {
                frames.current[f] = n;
              }}
              className="absolute inset-0"
              style={{ opacity: f === rest ? 1 : 0 }}
            >
              <Image
                src={frameSrc(scene.dir, f)}
                alt=""
                width={w}
                height={h}
                loading="eager"
                className="h-full w-full object-contain"
                draggable={false}
              />
            </div>
          ))}
        </div>
        <div ref={fx} className="absolute inset-0 overflow-visible" />
      </div>
      {labelAt === "bottom" && caption}
    </div>
  );
}

// seconds since startedAt (or since mount), ticking once a second. null on the server and first client render.
function useElapsed(startedAt?: string | number) {
  const [s, setS] = useState<number | null>(null);
  useEffect(() => {
    const parsed = startedAt == null ? NaN : typeof startedAt === "number" ? startedAt : Date.parse(startedAt);
    const t0 = Number.isFinite(parsed) ? parsed : Date.now();
    const up = () => setS(Math.max(0, Math.floor((Date.now() - t0) / 1000)));
    up();
    const i = setInterval(up, 1000);
    return () => clearInterval(i);
  }, [startedAt]);
  return s;
}
