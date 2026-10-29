"use client";

import Image from "next/image";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";

// The hero's two statues, smaller, turning to face each other across "you're set."
export function Finish({ onReview }: { onReview?: () => void }) {
  const still = useReducedMotion() ?? false;
  const side = (dir: 1 | -1, delay: number) => ({
    initial: still ? { opacity: 0 } : { opacity: 0, x: dir * -36 },
    animate: { opacity: 1, x: 0 },
    transition: { opacity: { duration: 0.6, delay }, x: { type: "spring" as const, stiffness: 80, damping: 18, delay } },
  });
  return (
    // clip sideways only on phones (where the statues' slide-in could scroll the page); on desktop the
    // glow must spill past the column or its blur shows hard edges at the max-w-2xl box
    <section className="relative isolate flex flex-col items-center pt-6 text-center max-sm:overflow-x-clip">
      {/* a radial gradient, not a blurred box: no filter edges or banding rings at any width */}
      <div className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[360px] w-[min(720px,100vw)] -translate-x-1/2 bg-[radial-gradient(closest-side,var(--lilac-soft),transparent)]" />
      <div className="flex w-full items-start justify-center gap-2 px-1 sm:gap-6 sm:px-6">
        <motion.div {...side(1, 0)} aria-hidden className="w-[70px] shrink-0 sm:w-[150px]">
          <Image src="/art/muse-astro.webp" alt="" width={878} height={1325} className="statue-fade" priority />
        </motion.div>
        <motion.div
          initial={still ? { opacity: 0 } : { opacity: 0, y: 16, filter: "blur(6px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ type: "spring", stiffness: 140, damping: 20, delay: 0.2 }}
          className="pt-6 sm:pt-16"
        >
          <p className="eyebrow mb-4">setup · done</p>
          <h1 className="display whitespace-nowrap text-[2.3rem] sm:text-[4.2rem]">
            you&rsquo;re <em>set.</em>
          </h1>
        </motion.div>
        <motion.div {...side(-1, 0.12)} aria-hidden className="w-[91px] shrink-0 sm:w-[195px]">
          <Image src="/art/sage-compass.webp" alt="" width={900} height={1128} className="statue-fade" priority />
        </motion.div>
      </div>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.55 }}
        className="mt-4 sm:-mt-10"
      >
        <Link href="/" autoFocus className="btn btn-primary px-6 py-3 text-[15px]">
          shape your first feature <span aria-hidden>→</span>
        </Link>
        {onReview ? (
          <button type="button" onClick={onReview} className="mt-4 block w-full text-[12px] text-grey transition-colors hover:text-ink">
            saved · review or change
          </button>
        ) : null}
      </motion.div>
    </section>
  );
}
