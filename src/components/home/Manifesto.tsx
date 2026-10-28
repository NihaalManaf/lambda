"use client";

import Image from "next/image";
import { motion, useReducedMotion } from "motion/react";

// The ideology. One line each — if it needs a paragraph, it isn't a tenet.
const TENETS = [
  { tag: "the enemy", line: <>slop is the enemy of <em>understanding.</em></> },
  { tag: "attention engineering", line: <>put developer attention where it <em>pays.</em></> },
  { tag: "show, don't tell", line: <>a diagram beats a <span className="outlined">hundred</span> paragraphs.</> },
  { tag: "structure", line: <>one-shot it. do it once, do it <em>right.</em></> },
  { tag: "values", line: <>simplicity · ease · understanding. <em>no compromise.</em></> },
];

// multiply melts the ivory highlights into the paper; the stone dissolves top + bottom so the columns
// rise out of the page instead of sitting on it like stickers
const FADE = "linear-gradient(to bottom, transparent 0%, #000 9%, #000 70%, transparent 100%)";
const BLEND = { mixBlendMode: "multiply", opacity: 0.92, maskImage: FADE, WebkitMaskImage: FADE } as const;
// one shared atmosphere so columns + tenets sit in the same room: warm stone glow at each pillar, lilac in the middle
const STONE = "color-mix(in srgb, var(--paper-2) 85%, #e9dcc6)";
const HAZE = {
  background: [
    `radial-gradient(28% 55% at 7% 60%, ${STONE} 0%, transparent 70%)`,
    `radial-gradient(28% 55% at 93% 60%, ${STONE} 0%, transparent 70%)`,
    "radial-gradient(40% 50% at 50% 50%, color-mix(in srgb, var(--lilac-soft) 70%, transparent) 0%, transparent 75%)",
  ].join(", "),
  filter: "blur(24px)",
};

// Laurel-wrapped marble column, one either side of the tenets (desktop only). The right one is mirrored
// so the garlands spiral away from each other. The tenet hairlines run the full width,
// behind the columns, so stone and words share one frieze.
function Pillar({ side }: { side: "left" | "right" }) {
  const still = useReducedMotion();
  return (
    <motion.div
      aria-hidden
      initial={{ opacity: 0, y: still ? 0 : 40 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ opacity: { duration: 0.9 }, y: { type: "spring", stiffness: 70, damping: 18 }, delay: side === "right" ? 0.15 : 0 }}
      className={`pointer-events-none relative z-10 row-start-2 hidden lg:block ${side === "left" ? "col-start-1" : "col-start-3"}`}
    >
      <Image
        src="/art/pillar-laurel.webp"
        alt=""
        width={410}
        height={1495}
        sizes="210px"
        style={BLEND}
        className={`absolute bottom-0 h-auto w-full ${side === "right" ? "-scale-x-100" : ""}`}
      />
    </motion.div>
  );
}

export function Manifesto() {
  return (
    <section className="relative isolate mx-auto grid max-w-[1440px] gap-x-6 px-6 pb-28 pt-8 lg:grid-cols-[clamp(110px,12vw,210px)_1fr_clamp(110px,12vw,210px)]">
      <div aria-hidden style={HAZE} className="pointer-events-none absolute inset-x-0 inset-y-6 -z-10 hidden lg:block" />
      <p className="eyebrow mb-8 lg:col-start-2 lg:row-start-1">manifesto</p>
      <Pillar side="left" />
      <ol className="divide-y divide-line border-y border-line lg:col-span-3 lg:col-start-1 lg:row-start-2 lg:[mask-image:linear-gradient(to_right,transparent,#000_12%,#000_88%,transparent)]">
        {TENETS.map((t, i) => (
          <motion.li
            key={t.tag}
            initial={{ opacity: 0, y: 16 }} // same on server + client; reduced motion is handled globally in css
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ delay: i * 0.05, type: "spring", stiffness: 160, damping: 22 }}
            className="group grid grid-cols-[3rem_1fr] items-baseline gap-4 py-7 md:grid-cols-[4rem_14rem_1fr] lg:px-[calc(clamp(110px,12vw,210px)+1.5rem)]"
          >
            <span className="font-mono text-xs text-grey">{String(i + 1).padStart(2, "0")}</span>
            <span className="eyebrow hidden md:block">{t.tag}</span>
            <p className="display text-[clamp(1.75rem,3.6vw,3rem)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:translate-x-1.5 [&_em]:italic">
              {t.line}
            </p>
          </motion.li>
        ))}
      </ol>
      <Pillar side="right" />
    </section>
  );
}
