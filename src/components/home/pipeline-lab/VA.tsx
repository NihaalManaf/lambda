"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { motion, useInView, useReducedMotion } from "motion/react";

// Engraving: three quiet Claude Code sessions on the left, one hairline threshold, and on the right the
// pictures lambda draws from them — fine line-art, one per session. One feature throughout: team invites.

// ─── content ─────────────────────────────────────────────────────────────────────────────────────────
type Line = { k: "prompt" | "tool" | "out" | "done"; t: string };
const SESSIONS: { title: string; lines: Line[] }[] = [
  {
    title: "acme — members page",
    lines: [
      { k: "prompt", t: "owners invite teammates by email, with a role" },
      { k: "tool", t: "Read(app/settings/members/page.tsx)" },
      { k: "out", t: "Read 142 lines" },
      { k: "done", t: "Worked for 41s" },
    ],
  },
  {
    title: "acme — invite links",
    lines: [
      { k: "prompt", t: "links expire after 7 days. then what?" },
      { k: "tool", t: "Read(app/invite/[token]/page.tsx)" },
      { k: "out", t: "no expiry check yet" },
      { k: "done", t: "Thought for 18s" },
    ],
  },
  {
    title: "acme — migrations",
    lines: [
      { k: "prompt", t: "where should pending invites live?" },
      { k: "tool", t: "Bash(ls db/migrations)" },
      { k: "out", t: "0041_members.sql  0042_workspaces.sql" },
      { k: "done", t: "Thought for 9s" },
    ],
  },
];
const FIGS = ["the members page", "the invite link", "where invites live"];
const NUM = ["i", "ii", "iii"];

// ─── timeline: one session at a time; its picture draws as the next one begins ──────────────────────
const LINE = 340; // ms between session lines
const GAP = 450; // finished → mark crosses the threshold
const SPAN = SESSIONS[0].lines.length * LINE + GAP;
const START = SESSIONS.map((_, i) => 300 + i * (SPAN + 250));
const CROSS = START.map((s) => s + SPAN - GAP + 120);
const DRAW = CROSS.map((c) => c + 520);
const END = DRAW[2] + 1600;

function useClock(run: boolean, still: boolean | null) {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!run || still) return;
    const marks = [
      ...START.flatMap((s) => SESSIONS[0].lines.map((_, j) => s + j * LINE)),
      ...CROSS,
      ...DRAW,
      END,
    ];
    const ids = marks.map((m) => setTimeout(() => setT((p) => Math.max(p, m)), m));
    return () => ids.forEach(clearTimeout);
  }, [run, still]);
  return still ? END : t;
}

const CAP = "mt-5 font-serif text-[15px] italic text-ink-2";

// ─── session window ──────────────────────────────────────────────────────────────────────────────────
const CORAL = "#d97757";

function Session({ i, t }: { i: number; t: number }) {
  const s = SESSIONS[i];
  return (
    <div className="card flex h-full flex-col px-6 pb-5 pt-4">
      <div className="mb-4 flex items-center gap-3">
        <span className="flex gap-1.5" aria-hidden>
          {[0, 1, 2].map((d) => (
            <span key={d} className="size-[7px] rounded-full border border-line-2" />
          ))}
        </span>
        <span className="font-mono text-[12px] text-grey">claude · ~/acme</span>
      </div>
      <div className="flex flex-1 flex-col font-mono text-[12.5px] leading-[1.75] text-ink-2 sm:text-[13.5px]">
        {s.lines.map((l, j) => {
          const on = t >= START[i] + j * LINE;
          return (
            <motion.div
              key={j}
              initial={false}
              animate={{ opacity: on ? 1 : 0, y: on ? 0 : 3 }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              className={`sm:truncate ${l.k === "prompt" ? "-indent-[2ch] pl-[2ch] sm:indent-0 sm:pl-0" : ""}`}
            >
              <SLine l={l} />
            </motion.div>
          );
        })}
        {/* the idle input box, as Claude Code leaves it */}
        <div className="mt-auto flex items-center gap-2 border-t border-line pt-3 text-grey">
          <span>&gt;</span>
          <span className="h-[15px] w-[7px] bg-line-2" />
        </div>
      </div>
    </div>
  );
}

function SLine({ l }: { l: Line }) {
  if (l.k === "prompt")
    return (
      <span className="text-ink">
        <span className="text-grey">&gt;</span> {l.t}
      </span>
    );
  if (l.k === "tool")
    return (
      <span>
        <span className="text-ink">⏺</span> {l.t}
      </span>
    );
  if (l.k === "out") return <span className="whitespace-pre text-grey">{"  ⎿  " + l.t}</span>;
  return (
    <span className="text-grey">
      <span style={{ color: CORAL }}>✻</span> {l.t}
    </span>
  );
}

// ─── line-art primitives ─────────────────────────────────────────────────────────────────────────────
const EASE = [0.22, 1, 0.36, 1] as const;
const W = 440;
const H = 220;

// rounded rect as a path so every stroke can draw itself in
const rr = (x: number, y: number, w: number, h: number, r = 0) =>
  r
    ? `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`
    : `M${x} ${y}H${x + w}V${y + h}H${x}Z`;

type Tone = "ink" | "soft" | "lilac" | "marker";
const STROKE: Record<Tone, string> = { ink: "var(--ink)", soft: "var(--line-2)", lilac: "var(--lilac)", marker: "var(--marker)" };

function P({ d, on, at = 0, tone = "ink", fill = "none", w = 1 }: { d: string; on: boolean; at?: number; tone?: Tone; fill?: string; w?: number }) {
  const [done, setDone] = useState(false);
  // once drawn, swap to a plain path: pathLength's dash leaves a seam where closed shapes meet
  if (done && on)
    return <path d={d} fill={fill} stroke={STROKE[tone]} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />;
  return (
    <motion.path
      onAnimationComplete={() => on && setDone(true)}
      d={d}
      fill={fill}
      stroke={STROKE[tone]}
      strokeWidth={w}
      strokeLinecap="round"
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
      initial={false}
      animate={on ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: 0 }}
      transition={{ pathLength: { duration: 1.1, ease: EASE, delay: at }, opacity: { duration: 0.2, delay: at } }}
    />
  );
}

function T({ on, at = 0.7, children, ...rest }: { on: boolean; at?: number; children: ReactNode } & React.SVGProps<SVGTextElement>) {
  return (
    <motion.text
      initial={false}
      animate={{ opacity: on ? 1 : 0 }}
      transition={{ duration: 0.6, delay: on ? at : 0 }}
      {...(rest as object)}
    >
      {children}
    </motion.text>
  );
}

const sans = { fontFamily: "var(--font-manrope)", fontSize: 13.5, fill: "var(--ink-2)" };
const mono = { fontFamily: "var(--font-inconsolata)", fontSize: 13, fill: "var(--ink-2)" };
const serif = { fontFamily: "var(--font-stix)", fill: "var(--ink)" };

// fig. i — browser frame, a members list, one marker circle + one note
function Sketch({ on }: { on: boolean }) {
  const rows = [
    { n: "ada", r: "owner", y: 92 },
    { n: "lin", r: "admin", y: 122 },
    { n: "sam", r: "member", y: 152 },
  ];
  return (
    <>
      <P on={on} d={rr(0.5, 0.5, 300, H - 1, 10)} />
      <P on={on} at={0.1} d={`M0.5 28H300.5`} tone="soft" />
      <P on={on} at={0.15} d={rr(84, 9, 140, 11, 5.5)} tone="soft" />
      {[14, 24, 34].map((x) => (
        <P key={x} on={on} at={0.1} d={`M${x + 2.5} 14.5a2.5 2.5 0 1 0 0.01 0`} tone="soft" />
      ))}
      <T on={on} at={0.5} x={22} y={60} style={{ ...serif, fontSize: 19 }}>
        members
      </T>
      <P on={on} at={0.3} d={rr(222, 45, 58, 22, 11)} />
      <T on={on} x={251} y={60} textAnchor="middle" style={{ ...sans, fontSize: 12 }}>
        invite
      </T>
      {rows.map((r, k) => (
        <g key={r.n}>
          <P on={on} at={0.35 + k * 0.08} d={`M31 ${r.y - 1}m-8 0a8 8 0 1 0 16 0a8 8 0 1 0 -16 0`} tone="soft" />
          <T on={on} at={0.7 + k * 0.08} x={48} y={r.y + 3.5} style={sans}>
            {r.n}
          </T>
          <T on={on} at={0.7 + k * 0.08} x={280} y={r.y + 3.5} textAnchor="end" style={{ ...sans, fill: "var(--grey)" }}>
            {r.r}
          </T>
          <P on={on} at={0.4 + k * 0.08} d={`M22 ${r.y + 15}H280`} tone="soft" />
        </g>
      ))}
      <T on={on} at={0.95} x={48} y={195} style={{ ...sans, fill: "var(--grey)", fontStyle: "italic" }}>
        jo@acme.app · pending
      </T>
      <T on={on} at={0.95} x={280} y={195} textAnchor="end" style={{ ...sans, fontSize: 12 }}>
        resend
      </T>
      {/* the one marker note */}
      <P on={on} at={1.1} tone="marker" w={1.6} d="M232 191c3-11 30-15 50-12c16 3 18 14 4 19c-17 5-48 4-55-3c-4-4-1-8 5-10" />
      <P on={on} at={1.35} tone="marker" w={1.4} d="M296 184c18-14 34-30 42-52M332 138l6-7l2 9" />
      <T on={on} at={1.6} x={322} y={118} style={{ fontFamily: "var(--font-kalam)", fontSize: 15, fill: "var(--marker)" }}>
        resend + revoke
      </T>
    </>
  );
}

// fig. ii — four steps, one decision, the edge case pinned in lilac
function Flow({ on }: { on: boolean }) {
  const node = (x: number, y: number, w: number, label: string, at: number, tone: Tone = "ink") => (
    <g key={label}>
      <P on={on} at={at} tone={tone} w={tone === "lilac" ? 1.5 : 1} d={rr(x, y, w, 34, 17)} fill={tone === "lilac" ? "var(--lilac-soft)" : "none"} />
      <T on={on} at={at + 0.5} x={x + w / 2} y={y + 21.5} textAnchor="middle" style={sans}>
        {label}
      </T>
    </g>
  );
  const arrow = (d: string, at: number) => <P on={on} at={at} d={d} tone="ink" />;
  return (
    <>
      {node(0.5, 48, 86, "invite", 0)}
      {arrow("M88 65H118M113 61l5 4l-5 4", 0.15)}
      {node(120, 48, 96, "email link", 0.2)}
      {arrow("M218 65H246M241 61l5 4l-5 4", 0.35)}
      <P on={on} at={0.4} d="M290 37L336 65L290 93L244 65Z" />
      <T on={on} at={0.9} x={290} y={69.5} textAnchor="middle" style={{ ...sans, fontSize: 12.5 }}>
        expired?
      </T>
      {arrow("M336 65H352M347 61l5 4l-5 4", 0.55)}
      {node(354, 48, 85, "joined", 0.6)}
      <T on={on} at={1} x={344} y={56} textAnchor="middle" style={{ ...mono, fill: "var(--grey)" }}>
        no
      </T>
      {arrow("M290 93V146M286 141l4 5l4-5", 0.6)}
      <T on={on} at={1} x={298} y={124} style={{ ...mono, fill: "var(--grey)" }}>
        yes
      </T>
      {node(214, 148, 152, "ask for a new link", 0.75, "lilac")}
      <T on={on} at={1.2} x={214} y={204} style={{ ...serif, fontSize: 13, fontStyle: "italic", fill: "var(--grey)" }}>
        pinned: after 7 days
      </T>
    </>
  );
}

// fig. iii — two existing tables, the new one outlined in lilac
function Schema({ on }: { on: boolean }) {
  const table = (x: number, y: number, w: number, name: string, cols: [string, string][], at: number, fresh = false) => {
    const h = 30 + cols.length * 22;
    return (
      <g key={name}>
        {/* header band fills first, the border draws over it */}
        <motion.path
          d={`M${x} ${y + 28}V${y + 6}A6 6 0 0 1 ${x + 6} ${y}H${x + w - 6}A6 6 0 0 1 ${x + w} ${y + 6}V${y + 28}Z`}
          fill={fresh ? "var(--lilac-soft)" : "var(--paper-2)"}
          initial={false}
          animate={{ opacity: on ? 1 : 0 }}
          transition={{ duration: 0.6, delay: on ? at + 0.3 : 0 }}
        />
        <P on={on} at={at} d={rr(x, y, w, h, 6)} tone={fresh ? "lilac" : "ink"} w={fresh ? 1.5 : 1} />
        <P on={on} at={at + 0.1} d={`M${x} ${y + 28}H${x + w}`} tone={fresh ? "lilac" : "soft"} />
        <T on={on} at={at + 0.5} x={x + 12} y={y + 19} style={{ ...serif, fontSize: 14.5 }}>
          {name}
        </T>
        {cols.map(([c, ty], k) => (
          <g key={c}>
            <T on={on} at={at + 0.6 + k * 0.05} x={x + 12} y={y + 46 + k * 22} style={mono}>
              {c}
            </T>
            <T on={on} at={at + 0.6 + k * 0.05} x={x + w - 12} y={y + 46 + k * 22} textAnchor="end" style={{ ...mono, fill: "var(--grey)" }}>
              {ty}
            </T>
          </g>
        ))}
      </g>
    );
  };
  return (
    <>
      {table(0.5, 0.5, 150, "workspaces", [["id", "uuid"], ["name", "text"]], 0)}
      {table(0.5, 112, 150, "members", [["user_id", "uuid"], ["role", "enum"]], 0.15)}
      <P on={on} at={0.3} d="M75 75V112" tone="ink" />
      {table(238, 26, 201, "invites", [["workspace_id", "uuid"], ["email", "citext"], ["role", "enum"], ["expires_at", "timestamptz"]], 0.35, true)}
      <P on={on} at={0.55} d="M151 42H194V68H238" tone="ink" />
    </>
  );
}

const ART = [Sketch, Flow, Schema];

function Figure({ i, on }: { i: number; on: boolean }) {
  const Art = ART[i];
  return (
    <figure className="w-full">
      <svg viewBox={`-2 -2 ${W + 4} ${H + 4}`} className="block w-full overflow-visible" aria-hidden>
        <Art on={on} />
      </svg>
      <motion.figcaption
        initial={false}
        animate={{ opacity: on ? 1 : 0 }}
        transition={{ duration: 0.8, delay: on ? 1.2 : 0 }}
        className={CAP}
      >
        fig. {NUM[i]} — {FIGS[i]}
      </motion.figcaption>
    </figure>
  );
}

// ─── section ─────────────────────────────────────────────────────────────────────────────────────────
// both columns hug the threshold at one shared width: a mirror, not a dashboard
const LEFT = "lg:w-full lg:max-w-[460px] lg:justify-self-end";
const RIGHT = "lg:w-full lg:max-w-[460px] lg:justify-self-start";
const ROW = ["lg:row-start-2", "lg:row-start-3", "lg:row-start-4"];

export default function PipelineEngraving({ count }: { count: number }) {
  const still = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.25 });
  const t = useClock(seen, still);

  return (
    <section className="mx-auto max-w-[1280px] px-6 pb-32 pt-12">
      <header className="flex flex-col items-center pb-20 text-center">
        <h2 className="display text-balance text-[clamp(2.25rem,4.2vw,3.5rem)]">
          sessions in, <em>pictures</em> out.
        </h2>
        <p className="mt-5 max-w-[44ch] text-[15px] leading-relaxed text-grey">
          every claude session leaves context behind. lambda reads it and draws what you would want to review.
        </p>
        <Link href="/features" className="mt-6 font-mono text-[13px] text-ink-2 underline decoration-line-2 underline-offset-4 transition-colors hover:text-ink">
          features {String(count).padStart(2, "0")} →
        </Link>
      </header>

      <div ref={ref} className="relative grid grid-cols-1 gap-y-10 lg:grid-cols-[1fr_96px_1fr] lg:gap-y-14">
        {/* the threshold */}
        <div aria-hidden className="absolute inset-y-0 left-1/2 hidden w-px -translate-x-1/2 bg-line-2 lg:block" />

        <p className={`eyebrow hidden lg:col-start-1 lg:row-start-1 lg:block ${LEFT}`}>claude code — sessions</p>
        <div className="relative hidden justify-center lg:col-start-2 lg:row-start-1 lg:flex">
          <span className="display relative -mt-1.5 bg-paper px-2 text-[22px] leading-none">λ</span>
        </div>
        <p className={`eyebrow hidden lg:col-start-3 lg:row-start-1 lg:block ${RIGHT}`}>lambda — pictures</p>

        <p className="eyebrow lg:hidden">claude code — sessions</p>
        {SESSIONS.map((_, i) => (
          <div key={i} className={`flex flex-col lg:col-start-1 ${LEFT} ${ROW[i]}`}>
            <div className="lg:flex-1">
              <Session i={i} t={t} />
            </div>
            <p className={CAP}>session {NUM[i]} — {SESSIONS[i].title.split(" — ")[1]}</p>
          </div>
        ))}

        {/* the mark crossing over when a session finishes */}
        {CROSS.map((c, i) => (
          <div key={i} aria-hidden className={`relative hidden lg:col-start-2 lg:block ${ROW[i]}`}>
            <motion.span
              initial={false}
              animate={t >= c && t < c + 900 ? { x: [-44, 44], opacity: [0, 1, 1, 0] } : { opacity: 0 }}
              transition={{ duration: 0.85, ease: "easeInOut", times: [0, 0.2, 0.8, 1] }}
              className="absolute left-1/2 top-1/2 -ml-[3px] -mt-[3px] size-1.5 rounded-full bg-lilac"
            />
          </div>
        ))}

        {/* phones: the threshold turns horizontal */}
        <div aria-hidden className="flex items-center gap-4 py-4 lg:hidden">
          <span className="h-px flex-1 bg-line-2" />
          <span className="display text-[22px] leading-none">λ</span>
          <span className="h-px flex-1 bg-line-2" />
        </div>

        <p className="eyebrow lg:hidden">lambda — pictures</p>
        {SESSIONS.map((_, i) => (
          <div key={i} className={`lg:col-start-3 ${RIGHT} ${ROW[i]}`}>
            <Figure i={i} on={t >= DRAW[i]} />
          </div>
        ))}
      </div>
    </section>
  );
}
