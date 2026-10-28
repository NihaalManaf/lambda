import type { SVGProps } from "react";
import type { FlowLens, FlowNodeKind } from "@/lib/types";

// Tiny 16px line glyphs. One stroke weight, round joins, currentColor — they read like the node shapes.

type G = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...p }: G) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...p}
    >
      {children}
    </svg>
  );
}

// ---------- lenses ----------

export const LensGlyph: Record<FlowLens, (p: G) => React.ReactNode> = {
  // person walking a path
  "customer-journey": (p) => (
    <Svg {...p}>
      <circle cx="4" cy="3.5" r="1.6" />
      <path d="M4 6.5v3.5M2 13l2-3 2 3" />
      <path d="M8.5 12.5h1.5a2 2 0 0 0 0-4H9a2 2 0 0 1 0-4h4.5" strokeDasharray="1.6 1.6" />
    </Svg>
  ),
  // stacked cylinder
  data: (p) => (
    <Svg {...p}>
      <ellipse cx="8" cy="3.8" rx="5" ry="1.8" />
      <path d="M3 3.8v8.4c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3.8" />
      <path d="M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8" />
    </Svg>
  ),
  // two boxes wired to a third
  infra: (p) => (
    <Svg {...p}>
      <rect x="1.8" y="2" width="4.6" height="3.6" rx="1" />
      <rect x="9.6" y="2" width="4.6" height="3.6" rx="1" />
      <rect x="5.7" y="10.4" width="4.6" height="3.6" rx="1" />
      <path d="M4.1 5.6v2.4h7.8V5.6M8 8v2.4" />
    </Svg>
  ),
  // state loop
  state: (p) => (
    <Svg {...p}>
      <circle cx="3.5" cy="8" r="2" />
      <circle cx="12.5" cy="8" r="2" />
      <path d="M5.2 6.6C6.6 4.6 9.4 4.6 10.8 6.6M10.8 9.4c-1.4 2-4.2 2-5.6 0" />
      <path d="M9.6 5.6l1.2 1 .3-1.5M6.4 10.4l-1.2-1-.3 1.5" />
    </Svg>
  ),
  // pencil
  custom: (p) => (
    <Svg {...p}>
      <path d="M10.8 2.6l2.6 2.6-7.6 7.6-3.2.6.6-3.2z" />
      <path d="M9.4 4l2.6 2.6" />
    </Svg>
  ),
};

// ---------- node kinds (mirror the chart shapes) ----------

export const KindGlyph: Record<FlowNodeKind, (p: G) => React.ReactNode> = {
  start: (p) => (
    <Svg {...p}>
      <rect x="1.5" y="5" width="13" height="6" rx="3" fill="currentColor" />
    </Svg>
  ),
  step: (p) => (
    <Svg {...p}>
      <rect x="2" y="4" width="12" height="8" rx="2.2" />
    </Svg>
  ),
  decision: (p) => (
    <Svg {...p}>
      <path d="M8 1.8L14.2 8 8 14.2 1.8 8z" />
    </Svg>
  ),
  end: (p) => (
    <Svg {...p}>
      <rect x="1.5" y="5" width="13" height="6" rx="3" />
    </Svg>
  ),
  error: (p) => (
    <Svg {...p}>
      <rect x="2" y="4" width="12" height="8" rx="2.2" />
      <path d="M6.2 6.2l3.6 3.6M9.8 6.2l-3.6 3.6" />
    </Svg>
  ),
  external: (p) => (
    <Svg {...p}>
      <rect x="2" y="4" width="12" height="8" rx="2.2" strokeDasharray="2 1.6" />
    </Svg>
  ),
  store: (p) => (
    <Svg {...p}>
      <ellipse cx="8" cy="4" rx="5" ry="1.8" />
      <path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4" />
    </Svg>
  ),
};

// ---------- actions ----------

export const Icon = {
  plus: (p: G) => (
    <Svg {...p}>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  ),
  branch: (p: G) => (
    <Svg {...p}>
      <path d="M5 2.5v11M5 7.5c0-2 1.5-3 3.5-3H12" />
      <path d="M10.2 2.7L12 4.5l-1.8 1.8" />
    </Svg>
  ),
  pin: (p: G) => (
    <Svg {...p}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.4M8 10.8v.1" />
    </Svg>
  ),
  trash: (p: G) => (
    <Svg {...p}>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
    </Svg>
  ),
  undo: (p: G) => (
    <Svg {...p}>
      <path d="M5.5 3.5L2.8 6.2l2.7 2.7" />
      <path d="M3 6.2h6.5a3.7 3.7 0 0 1 0 7.4H6" />
    </Svg>
  ),
  link: (p: G) => (
    <Svg {...p}>
      <circle cx="3.6" cy="12.4" r="1.8" />
      <circle cx="12.4" cy="3.6" r="1.8" />
      <path d="M5 11L11 5" strokeDasharray="1.8 1.6" />
    </Svg>
  ),
  wand: (p: G) => (
    <Svg {...p}>
      <path d="M2.5 13.5l7.5-7.5M9 3.2V1.8M12.8 7h1.4M11.6 4.4l1-1M3.2 2l.5 1.4M6.4 2.6V1.8" />
      <path d="M8.6 5.6l1.8 1.8" />
    </Svg>
  ),
  close: (p: G) => (
    <Svg {...p}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  ),
  check: (p: G) => (
    <Svg {...p}>
      <path d="M3.2 8.4l3 3 6.6-6.8" />
    </Svg>
  ),
  arrow: (p: G) => (
    <Svg {...p}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </Svg>
  ),
};
