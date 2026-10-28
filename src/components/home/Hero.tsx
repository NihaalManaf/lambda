"use client";

import Image from "next/image";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";

// Two statues face each other across the headline: ivory astronaut (left, looking right),
// graphite sage with a compass (right, looking left).
//
// Measured geometry (fractions of each image's width W):
//   muse  — eye at (57%, 0.317W from top); face (eye→chin) = 0.24W; helmet glass ends at 87%
//   sage  — eye at (52%, 0.263W from top); face (eye→chin) = 0.15W; compass hand starts at 13%
// → sage renders at 1.3× muse width so the faces read alike (his beard + bust carry extra mass, so not the full 1.6×),
// → both eye lines sit on the centre of the headline's first line,
// → clear air between headline and each statue's nearest edge (glass / compass) = GAP on both sides,
// → statues float (zero-height cells) so they never push the composer down.
const FS = "clamp(2.5rem,5.4vw,5.5rem)"; // headline font size
const W = "clamp(200px,17.5vw,300px)"; // muse width; sage = 1.3W
const K = 1.3;
const GAP = 0.16; // × muse width
const EYEBROW = "40px"; // eyebrow line + its margin above the h1
const LINE1 = `(${EYEBROW} + 0.475 * var(--fs))`; // centre of headline line 1 (line-height .95)

export function Hero() {
  const still = useReducedMotion();
  const { scrollY } = useScroll();
  const leftY = useTransform(scrollY, [0, 600], [0, still ? 0 : 60]);
  const rightY = useTransform(scrollY, [0, 600], [0, still ? 0 : 60]);
  const drift = (dir: 1 | -1) => (still ? undefined : { y: [0, -8, 0], rotate: [0, dir * 1, 0] });
  const loop = (d: number, delay = 0) => ({ duration: d, repeat: Infinity, ease: "easeInOut" as const, delay });

  return (
    <section className="relative isolate overflow-x-clip">
      {/* lilac haze where the gazes meet */}
      <div className="pointer-events-none absolute left-1/2 top-20 -z-10 h-[440px] w-[720px] -translate-x-1/2 rounded-full bg-lilac-soft/80 blur-3xl" />

      <div
        className="mx-auto grid max-w-[1440px] grid-cols-1 px-6 pb-16 pt-16 lg:grid-cols-[1fr_auto_1fr] lg:pb-16 lg:pt-20"
        style={{ ["--fs" as string]: FS, ["--w" as string]: W }}
      >
        {/* muse: hugs the right edge of her column */}
        <motion.div
          aria-hidden
          style={{ y: leftY, width: "var(--w)", marginTop: `calc(${LINE1} - 0.317 * var(--w))`, marginRight: `calc((${GAP} - 0.13) * var(--w))` }}
          className="pointer-events-none relative hidden h-0 justify-self-end lg:block"
        >
          <motion.div
            initial={{ opacity: 0, x: -40 }}
            animate={{ opacity: 1, x: 0, ...drift(1) }}
            transition={{ opacity: { duration: 0.9 }, x: { type: "spring", stiffness: 70, damping: 18 }, y: loop(8), rotate: loop(10) }}
          >
            <Image src="/art/muse-astro.webp" alt="" width={878} height={1325} priority className="statue-fade" />
          </motion.div>
        </motion.div>

        <div className="relative z-10 flex flex-col items-center text-center">
          {/* phones/tablets: one small statue peeks above the headline */}
          <Image
            src="/art/muse-astro.webp"
            alt=""
            aria-hidden
            width={878}
            height={1325}
            priority
            className="fade-b pointer-events-none mb-4 w-[110px] lg:hidden"
          />
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 120, damping: 20 }}
            className="enter"
          >
            <p className="eyebrow mb-6 h-4 leading-4">λ — attention engineering</p>
            <h1 className="display" style={{ fontSize: "var(--fs)" }}>
              <span className="block lg:whitespace-nowrap">
                engineer <em>attention.</em>
              </span>
              <span className="block lg:whitespace-nowrap">
                let agents <span className="outlined italic">build</span> it.
              </span>
            </h1>
          </motion.div>
        </div>

        {/* sage: 1.3× wide, hugs the left edge of his column */}
        <motion.div
          aria-hidden
          style={{
            y: rightY,
            width: `calc(${K} * var(--w))`,
            marginTop: `calc(${LINE1} - 0.263 * ${K} * var(--w))`,
            marginLeft: `calc((${GAP} - 0.13 * ${K}) * var(--w))`,
          }}
          className="pointer-events-none relative hidden h-0 justify-self-start lg:block"
        >
          <motion.div
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0, ...drift(-1) }}
            transition={{
              opacity: { duration: 0.9, delay: 0.15 },
              x: { type: "spring", stiffness: 70, damping: 18, delay: 0.15 },
              y: loop(9, 1),
              rotate: loop(11, 1),
            }}
          >
            <Image src="/art/sage-compass.webp" alt="" width={900} height={1128} priority className="statue-fade" />
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
