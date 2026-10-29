// The march of progress as a stone frieze: ape → hominid → classical man → classical man with a laptop, the stone
// going from rough graphite to polished ivory. While lambda works, the figures light up left to right and fade,
// on a loop. One generated still split into its figures (style.md → loaders), so each can be lit on its own.

// [left, width] of each figure in its 96px-tall cut, as split from the still: strides overlap, so boxes do too
const FIGS = [
  [0, 53],
  [50, 53],
  [94, 59],
  [149, 51],
  [189, 52],
  [237, 56],
] as const;
const CUT_H = 96;
const SPAN = FIGS[FIGS.length - 1][0] + FIGS[FIGS.length - 1][1];
const STEP = 0.32; // seconds between figures: the wave walks left to right
const LOOP = 3.6;

const CSS = `
@keyframes evolve {
  0% { opacity: 0.16; transform: translateY(1px); }
  10% { opacity: 1; transform: translateY(0); }
  58% { opacity: 1; transform: translateY(0); }
  78%, 100% { opacity: 0.16; transform: translateY(1px); }
}
.evolve { opacity: 0.16; animation: evolve ${LOOP}s cubic-bezier(0.22, 1, 0.36, 1) infinite; }
@media (prefers-reduced-motion: reduce) {
  .evolve { animation: none; opacity: 1; }
}`;

// spread = extra px between neighbouring figures (0 = as carved, strides overlapping)
export default function Evolution({ height = 28, spread = 0, label = "working", className }: { height?: number; spread?: number; label?: string; className?: string }) {
  const k = height / CUT_H;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`relative inline-block shrink-0 ${className ?? ""}`}
      style={{ width: Math.round(SPAN * k + spread * (FIGS.length - 1)), height }}
    >
      <style>{CSS}</style>
      {FIGS.map(([left, width], i) => (
        // eslint-disable-next-line @next/next/no-img-element -- tiny decorative cut-outs, sized by hand
        <img
          key={i}
          src={`/art/march/${i}.webp`}
          alt=""
          aria-hidden
          draggable={false}
          className="evolve pointer-events-none absolute top-0 select-none"
          style={{ left: left * k + i * spread, width: width * k, height, animationDelay: `${i * STEP}s` }}
        />
      ))}
    </span>
  );
}
