// An ivory marble globe turning on an ionic pedestal: the "an agent is working" mark for compact places (cards,
// pills) where the atelier loaders (scribe, sculptor, painter) don't fit. Generated + rendered like the art
// (style.md → loaders): one still, a carved-marble map projected onto its sphere, 24 baked frames in one strip,
// hard-cut with css steps() so it reads as stop-motion like its siblings.

const STRIP = "/art/globe/spin.webp";
const FRAMES = 24;
const FRAME = [136, 240] as const; // one frame of the strip, px
const TURN = 3.6; // seconds per turn

const CSS = `
@keyframes globe-turn { to { background-position-x: calc(var(--globe-w) * -${FRAMES}); } }
.globe-turn { animation: globe-turn ${TURN}s steps(${FRAMES}) infinite; }
@media (prefers-reduced-motion: reduce) {
  .globe-turn { animation: none; }
}`;

export default function Globe({ height = 48, label = "working", className }: { height?: number; label?: string; className?: string }) {
  const w = Math.round((height * FRAME[0]) / FRAME[1]);
  return (
    <span
      role="img"
      aria-label={label}
      className={`globe-turn inline-block bg-no-repeat ${className ?? ""}`}
      style={{
        width: w,
        height,
        backgroundImage: `url(${STRIP})`,
        backgroundSize: `${w * FRAMES}px ${height}px`,
        ["--globe-w" as string]: `${w}px`,
      }}
    >
      <style>{CSS}</style>
    </span>
  );
}
