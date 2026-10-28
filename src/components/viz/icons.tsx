import type { IconName } from "@/lib/types";

// Inline stroke icons on a 16-unit grid: currentColor, 1.5 stroke, no fills.

const P: Record<IconName, React.ReactNode> = {
  key: (
    <>
      <circle cx="5" cy="8" r="3" />
      <path d="M8 8h6.5M12 8v2.5M14.5 8v2" />
    </>
  ),
  link: <path d="M6.5 9.5l3-3M7.2 4.6l1-1a2.6 2.6 0 013.7 3.7l-1 1M8.8 11.4l-1 1a2.6 2.6 0 01-3.7-3.7l1-1" />,
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
    </>
  ),
  bolt: <path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z" />,
  index: <path d="M3 4h10M3 8h7M3 12h4" />,
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  bucket: <path d="M3 4.5h10l-1.2 9H4.2zM3 4.5c0-1 2.2-1.8 5-1.8s5 .8 5 1.8" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
  retry: <path d="M13 8a5 5 0 11-1.5-3.6M13 2.5v3h-3" />,
  delay: <path d="M4.5 1.5h7M4.5 14.5h7M5.5 1.5v1.5c0 2.2 5 2.8 5 5s-5 2.8-5 5v1.5M10.5 1.5v1.5c0 2.2-5 2.8-5 5s5 2.8 5 5v1.5" />,
  dedup: (
    <>
      <rect x="2.5" y="2.5" width="8" height="8" rx="1.5" />
      <path d="M5.5 13.5H12a1.5 1.5 0 001.5-1.5V5.5" />
    </>
  ),
  flow: <path d="M2 3h12l-4.5 5.5V13l-3 1.5v-6z" />,
  callback: <path d="M6 4L2.5 7.5 6 11M2.5 7.5h7.5a3.5 3.5 0 010 7H8" />,
  shield: <path d="M8 1.5l5.5 2v4c0 3.5-2.5 6-5.5 7-3-1-5.5-3.5-5.5-7v-4z" />,
  queue: <path d="M2 5h3v6H2zM6.5 5h3v6h-3zM11 5h3v6h-3z" />,
  cron: (
    <>
      <rect x="2" y="3" width="12" height="11" rx="1.5" />
      <path d="M2 6.5h12M5 1.5v3M11 1.5v3" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c-3.3 3.5-3.3 8.5 0 12M8 2c3.3 3.5 3.3 8.5 0 12" />
    </>
  ),
  file: <path d="M4 1.5h5l3.5 3.5v9.5H4zM9 1.5V5h3.5" />,
  warn: <path d="M8 2l6.5 11.5h-13zM8 6.5V10M8 12v.01" />,
  code: <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" />,
  loop: <path d="M3 8a5 5 0 019-3M13 8a5 5 0 01-9 3M12 2v3H9M4 14v-3h3" />,
  split: <path d="M8 14.5V9M8 9L3.5 3M8 9l4.5-6M3 5.5V3h2.5M13 5.5V3h-2.5" />,
};

export function Icon({ name, size = 14, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {P[name]}
    </svg>
  );
}

export default Icon;
