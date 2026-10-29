"use client";

import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";

// Sessions in, pictures out: three quiet Claude Code sessions on the left, one hairline threshold,
// and on the right the picture lambda draws from each — fine line-art on the paper. One feature: team invites.

// ─── content ─────────────────────────────────────────────────────────────────────────────────────────
type Line = { k: "prompt" | "tool" | "out" | "say" | "done"; t: string };
const SESSIONS: { name: string; fig: string; lines: Line[] }[] = [
  {
    name: "members page",
    fig: "the members page",
    lines: [
      { k: "prompt", t: "owners invite teammates by email, with a role" },
      { k: "tool", t: "Read(app/settings/members/page.tsx)" },
      { k: "out", t: "Read 142 lines" },
      { k: "say", t: "Pending invites sit under the list, with resend." },
      { k: "done", t: "Worked for 41s" },
    ],
  },
  {
    name: "invite links",
    fig: "the invite link",
    lines: [
      { k: "prompt", t: "links expire after 7 days. then what?" },
      { k: "tool", t: "Read(app/invite/[token]/page.tsx)" },
      { k: "out", t: "no expiry check yet" },
      { k: "say", t: "An expired link should ask for a new one." },
      { k: "done", t: "Thought for 18s" },
    ],
  },
  {
    name: "migrations",
    fig: "where invites live",
    lines: [
      { k: "prompt", t: "where should pending invites live?" },
      { k: "tool", t: "Bash(ls db/migrations)" },
      { k: "out", t: "0041_members.sql  0042_workspaces.sql" },
      { k: "say", t: "A new invites table, keyed to workspaces." },
      { k: "done", t: "Thought for 9s" },
    ],
  },
];
const NUM = ["i", "ii", "iii"];

// ─── timeline, per row: lines appear → the source line is marked → a mark crosses → the picture draws ──
const LINE = 150;
const MARKS = SESSIONS[0].lines.map((_, j) => j * LINE);
const HL = MARKS[MARKS.length - 1] + 180; // the line that becomes the picture
const CROSS = HL + 140;
const DRAW = CROSS + 350;
const HL_OFF = DRAW + 1700;
const NEXT = CROSS; // the next row's session begins while this picture draws

// reduced motion: every primitive renders its final state, no transitions
const Still = createContext(false);

// `final` jumps straight to the end state (reduced motion, or a row scrolled past unseen)
function useRowClock(run: boolean, final: boolean) {
  const [t, setT] = useState(-1);
  useEffect(() => {
    if (!run || final) return;
    const ids = [...MARKS, HL, CROSS, DRAW, HL_OFF].map((m) => setTimeout(() => setT((p) => Math.max(p, m)), m));
    return () => ids.forEach(clearTimeout);
  }, [run, final]);
  return final ? HL_OFF : t;
}

const EASE = [0.22, 1, 0.36, 1] as const;
const CAP = "mt-5 font-serif text-[15px] italic leading-6 text-ink-2";
const CORAL = "#d97757";

// ─── session window ──────────────────────────────────────────────────────────────────────────────────
function Session({ i, t }: { i: number; t: number }) {
  const still = useContext(Still);
  const marked = t >= HL && t < HL_OFF;
  return (
    <div className="card flex h-full flex-col px-6 pb-[18px] pt-4">
      <div className="mb-4 flex items-center gap-3">
        <span className="flex gap-1.5" aria-hidden>
          {[0, 1, 2].map((d) => (
            <span key={d} className="size-[7px] rounded-full border border-line-2" />
          ))}
        </span>
        <span className="font-mono text-[13px] text-grey">claude · ~/acme</span>
      </div>
      <div className="flex flex-1 flex-col font-mono text-[13px] leading-[1.65] text-ink-2 sm:text-[14px]">
        {SESSIONS[i].lines.map((l, j) => {
          const on = t >= MARKS[j];
          return (
            <motion.div
              key={j}
              initial={false}
              animate={{ opacity: on ? 1 : 0, y: on ? 0 : 3 }}
              transition={still ? { duration: 0 } : { duration: 0.3, ease: EASE }}
              className={`relative flex ${l.k === "done" ? "mt-auto pt-2" : ""}`}
            >
              {l.k === "say" && (
                <motion.span
                  aria-hidden
                  initial={false}
                  animate={{ opacity: marked ? 1 : 0, scaleY: marked ? 1 : 0.4 }}
                  transition={{ duration: 0.6, ease: EASE }}
                  className="absolute -left-3 bottom-[0.3em] top-[0.3em] w-[2px] rounded-full bg-lilac"
                />
              )}
              <SLine l={l} />
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

// marker glyph in a fixed gutter so wrapped lines hang under the text, as in the terminal
function SLine({ l }: { l: Line }) {
  const g = (c: ReactNode, w = "w-[2ch]", cls = "") => <span aria-hidden className={`shrink-0 whitespace-pre ${w} ${cls}`}>{c}</span>;
  if (l.k === "prompt")
    return (
      <>
        {g(">", undefined, "text-grey")}
        <span className="text-ink">{l.t}</span>
      </>
    );
  if (l.k === "tool" || l.k === "say")
    return (
      <>
        {g("⏺", undefined, "text-ink")}
        <span className="min-w-0 break-words">{l.t}</span>
      </>
    );
  if (l.k === "out")
    return (
      <>
        {g("  ⎿", "w-[5ch]", "text-grey")}
        <span className="min-w-0 whitespace-pre-wrap">{l.t}</span>
      </>
    );
  return (
    <>
      {g(<span style={{ color: CORAL }}>✻</span>)}
      <span>{l.t}</span>
    </>
  );
}

// ─── line-art primitives ─────────────────────────────────────────────────────────────────────────────
const W = 360;
const H = 172;

const rr = (x: number, y: number, w: number, h: number, r = 0) =>
  r
    ? `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`
    : `M${x} ${y}H${x + w}V${y + h}H${x}Z`;

type Tone = "ink" | "soft" | "lilac" | "marker";
const STROKE: Record<Tone, string> = { ink: "var(--ink-2)", soft: "var(--line-2)", lilac: "var(--lilac)", marker: "var(--marker)" };

function P({ d, on, at = 0, tone = "ink", fill = "none", w = 1 }: { d: string; on: boolean; at?: number; tone?: Tone; fill?: string; w?: number }) {
  const still = useContext(Still);
  const [done, setDone] = useState(false);
  const base = { d, fill, stroke: STROKE[tone], strokeWidth: w, strokeLinecap: "round", strokeLinejoin: "round", vectorEffect: "non-scaling-stroke" } as const;
  // once drawn, swap to a plain path: pathLength's dash leaves a seam where closed shapes meet
  if (still || (done && on)) return <path {...base} />;
  return (
    <motion.path
      {...base}
      onAnimationComplete={() => on && setDone(true)}
      initial={false}
      animate={on ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: 0 }}
      transition={{ pathLength: { duration: 1.1, ease: EASE, delay: at }, opacity: { duration: 0.2, delay: at } }}
    />
  );
}

type TextProps = { x: number; y: number; textAnchor?: "middle" | "end"; style: CSSProperties };
function T({ on, at = 0.6, children, ...rest }: { on: boolean; at?: number; children: ReactNode } & TextProps) {
  const still = useContext(Still);
  if (still) return <text {...rest}>{children}</text>;
  return (
    <motion.text
      initial={false}
      animate={{ opacity: on ? 1 : 0 }}
      transition={{ duration: 0.6, delay: on ? at : 0 }}
      {...rest}
    >
      {children}
    </motion.text>
  );
}

const sans = { fontFamily: "var(--font-manrope)", fontSize: 13.5, fill: "var(--ink-2)" };
const mono = { fontFamily: "var(--font-inconsolata)", fontSize: 13.5, fill: "var(--ink-2)" };
const serif = { fontFamily: "var(--font-stix)", fill: "var(--ink)" };
const grey = { ...sans, fill: "var(--grey)" };

// fig. i — browser frame, a members list, one marker circle + one note
function Sketch({ on }: { on: boolean }) {
  const rows = [
    { n: "ada", r: "owner", y: 84 },
    { n: "lin", r: "admin", y: 114 },
  ];
  return (
    <>
      <P on={on} d={rr(0.5, 0.5, W - 1, H - 1, 10)} />
      <P on={on} at={0.1} d={`M0.5 24H${W - 0.5}`} tone="soft" />
      <P on={on} at={0.15} d={rr(120, 7, 120, 10, 5)} tone="soft" />
      {[12, 21, 30].map((x) => (
        <P key={x} on={on} at={0.1} d={`M${x - 2.5} 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0`} tone="soft" />
      ))}
      <T on={on} at={0.4} x={18} y={55} style={{ ...serif, fontSize: 17 }}>
        members
      </T>
      <P on={on} at={0.3} d={rr(284, 38, 58, 22, 11)} />
      <T on={on} x={313} y={53.5} textAnchor="middle" style={sans}>
        invite
      </T>
      {rows.map((r, k) => (
        <g key={r.n}>
          <P on={on} at={0.35 + k * 0.08} d={`M19 ${r.y - 4}a7 7 0 1 0 14 0a7 7 0 1 0 -14 0`} tone="soft" />
          <T on={on} at={0.6 + k * 0.08} x={42} y={r.y} style={sans}>
            {r.n}
          </T>
          <T on={on} at={0.6 + k * 0.08} x={342} y={r.y} textAnchor="end" style={grey}>
            {r.r}
          </T>
          <P on={on} at={0.4 + k * 0.08} d={`M18 ${r.y + 13}H342`} tone="soft" />
        </g>
      ))}
      <P on={on} at={0.55} d="M19 140a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" tone="soft" />
      <T on={on} at={0.8} x={42} y={144} style={{ ...grey, fontStyle: "italic" }}>
        jo@acme.app
      </T>
      <T on={on} at={0.8} x={262} y={144} textAnchor="end" style={sans}>
        resend
      </T>
      {/* the one marker note: the empty slot beside resend, where revoke should go */}
      <P on={on} at={1} tone="marker" w={1.5} d="M276 146c-4-8 9-15 31-16c21-1 37 4 36 11c-1 8-17 11-34 11c-15 0-27-3-31-8" />
      <T on={on} at={1.3} x={309} y={146} textAnchor="middle" style={{ fontFamily: "var(--font-kalam)", fontSize: 14, fill: "var(--marker)" }}>
        + revoke
      </T>
    </>
  );
}

// fig. ii — three steps, one decision, the edge case pinned in lilac
function Flow({ on }: { on: boolean }) {
  const node = (x: number, y: number, w: number, label: string, at: number, pin = false) => (
    <g key={label}>
      <P on={on} at={at} tone={pin ? "lilac" : "ink"} w={pin ? 1.25 : 1} d={rr(x, y, w, 30, 15)} />
      <T on={on} at={at + 0.45} x={x + w / 2} y={y + 19.5} textAnchor="middle" style={sans}>
        {label}
      </T>
    </g>
  );
  const arrow = (x1: number, x2: number, at: number) => <P on={on} at={at} d={`M${x1} 40H${x2}M${x2 - 4} 36.5l4 3.5l-4 3.5`} />;
  return (
    <>
      {node(0.5, 25, 64, "invite", 0)}
      {arrow(66, 84, 0.15)}
      {node(86, 25, 82, "email link", 0.2)}
      {arrow(170, 187, 0.35)}
      <P on={on} at={0.4} d="M226 16L264 40L226 64L188 40Z" />
      <T on={on} at={0.85} x={226} y={44} textAnchor="middle" style={sans}>
        expired?
      </T>
      {arrow(264, 280, 0.55)}
      <T on={on} at={0.95} x={272} y={30} textAnchor="middle" style={{ ...mono, fill: "var(--grey)" }}>
        no
      </T>
      {node(282, 25, 77, "joined", 0.6)}
      <P on={on} at={0.6} d="M226 64V110M222.5 106l3.5 4l3.5-4" />
      <T on={on} at={0.95} x={234} y={92} style={{ ...mono, fill: "var(--grey)" }}>
        yes
      </T>
      {node(156, 112, 140, "ask for a new link", 0.75, true)}
      <T on={on} at={1.2} x={226} y={166} textAnchor="middle" style={{ ...serif, fontSize: 13.5, fontStyle: "italic", fill: "var(--grey)" }}>
        pinned · after 7 days
      </T>
    </>
  );
}

// fig. iii — two existing tables, the new one outlined in lilac
function Schema({ on }: { on: boolean }) {
  const still = useContext(Still);
  const table = (x: number, y: number, w: number, name: string, cols: [string, string][], at: number, fresh = false) => {
    const h = 26 + cols.length * 22 + 4;
    return (
      <g key={name}>
        {/* header band settles in under the drawn border */}
        <motion.path
          d={`M${x} ${y + 26}V${y + 6}A6 6 0 0 1 ${x + 6} ${y}H${x + w - 6}A6 6 0 0 1 ${x + w} ${y + 6}V${y + 26}Z`}
          fill="var(--paper-2)"
          initial={false}
          animate={{ opacity: on ? 1 : 0 }}
          transition={still ? { duration: 0 } : { duration: 0.6, delay: on ? at + 0.3 : 0 }}
        />
        <P on={on} at={at} d={rr(x, y, w, h, 6)} tone={fresh ? "lilac" : "ink"} w={fresh ? 1.25 : 1} />
        <P on={on} at={at + 0.1} d={`M${x} ${y + 26}H${x + w}`} tone={fresh ? "lilac" : "soft"} />
        <T on={on} at={at + 0.45} x={x + 11} y={y + 18} style={{ ...serif, fontSize: 15 }}>
          {name}
        </T>
        {cols.map(([c, ty], k) => (
          <g key={c}>
            <T on={on} at={at + 0.55 + k * 0.05} x={x + 11} y={y + 43 + k * 22} style={mono}>
              {c}
            </T>
            <T on={on} at={at + 0.55 + k * 0.05} x={x + w - 11} y={y + 43 + k * 22} textAnchor="end" style={{ ...mono, fill: "var(--grey)" }}>
              {ty}
            </T>
          </g>
        ))}
      </g>
    );
  };
  return (
    <>
      {table(0.5, 0.5, 128, "workspaces", [["id", "uuid"], ["name", "text"]], 0)}
      <P on={on} at={0.25} d="M64.5 74.5V96.5" />
      {table(0.5, 96.5, 128, "members", [["user_id", "uuid"], ["role", "enum"]], 0.15)}
      <P on={on} at={0.4} d="M128.5 39H175.5" />
      {table(175.5, 0.5, 184, "invites", [["workspace_id", "uuid"], ["email", "citext"], ["role", "enum"], ["expires_at", "timestamptz"]], 0.35, true)}
    </>
  );
}

const ART = [Sketch, Flow, Schema];

function Figure({ i, on }: { i: number; on: boolean }) {
  const still = useContext(Still);
  const Art = ART[i];
  return (
    <figure className="w-full">
      <svg viewBox={`-2 -2 ${W + 4} ${H + 4}`} className="block w-full overflow-visible" aria-hidden>
        <Art on={on} />
      </svg>
      <motion.figcaption
        initial={false}
        animate={{ opacity: on ? 1 : 0 }}
        transition={still ? { duration: 0 } : { duration: 0.8, delay: on ? 1.1 : 0 }}
        className={CAP}
      >
        fig. {NUM[i]} — {SESSIONS[i].fig}
      </motion.figcaption>
    </figure>
  );
}

function Head({ word, note, className }: { word: string; note: string; className: string }) {
  return (
    <div className={className}>
      <p className="display text-[34px] italic leading-none">{word}</p>
      <p className="eyebrow mt-3">{note}</p>
    </div>
  );
}

// ─── one row: a session, the threshold, its picture ──────────────────────────────────────────────────
const COLS = "grid grid-cols-1 lg:grid-cols-[1fr_112px_1fr]";
const LEFT = "w-full max-w-[440px] justify-self-center lg:justify-self-end";
const RIGHT = "w-full max-w-[440px] justify-self-center lg:justify-self-start";

type RowProps = { i: number; go: boolean; skip: boolean; els: RefObject<(HTMLDivElement | null)[]>; onSeen: () => void; onNext: () => void };
function Row({ i, go, skip, els, onSeen, onNext }: RowProps) {
  const still = useContext(Still);
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.25 });
  useEffect(() => {
    els.current[i] = ref.current;
  }, [els, i]);
  useEffect(() => {
    if (seen) onSeen();
  }, [seen, onSeen]);
  const t = useRowClock(go, still || skip);
  useEffect(() => {
    if (t >= NEXT) onNext();
  }, [t, onNext]);
  const crossing = t >= CROSS && t < CROSS + 900;

  return (
    <div ref={ref} className={COLS}>
      <div className={`flex flex-col ${LEFT}`}>
        <div className="flex-1">
          <Session i={i} t={t} />
        </div>
        <p className={CAP}>
          session {NUM[i]} — {SESSIONS[i].name}
        </p>
      </div>

      {/* desktop: a faint mark crosses the line; phones: the line turns horizontal between the pair */}
      <div aria-hidden className="relative">
        <div className="absolute inset-x-0 top-0 hidden lg:block" style={{ bottom: 44 }}>
          {/* which way it reads: session → picture */}
          <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-paper px-1.5 py-1 text-[15px] leading-none text-grey">
            →
          </span>
          {!still && (
            <motion.span
              initial={false}
              animate={crossing ? { x: [-48, 48], opacity: [0, 1, 1, 0] } : { opacity: 0 }}
              transition={{ duration: 0.85, ease: "easeInOut", times: [0, 0.2, 0.8, 1] }}
              className="absolute left-1/2 top-1/2 -ml-[3px] -mt-[3px] size-1.5 rounded-full bg-lilac"
            />
          )}
        </div>
        <div className="flex items-center gap-4 py-7 lg:hidden">
          <span className="h-px flex-1 bg-line-2" />
          <span className="display text-[18px] leading-none text-ink-2">λ ↓</span>
          <span className="h-px flex-1 bg-line-2" />
        </div>
      </div>

      <div className={RIGHT}>
        <Figure i={i} on={t >= DRAW} />
      </div>
    </div>
  );
}

type Stage = "idle" | "seen" | "handed" | "skip";

// ─── section ─────────────────────────────────────────────────────────────────────────────────────────
export function Pipeline() {
  const reduced = useReducedMotion();
  // server and first client paint agree (nothing drawn yet); reduced motion settles after mount
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const still = mounted && !!reduced;
  // rows play in order: a seen row waits for the one above to hand over. rows the viewer
  // scrolled past unseen (jump, restore, fling) settle straight into their final state.
  const [st, setSt] = useState<Stage[]>(() => SESSIONS.map(() => "idle"));
  const els = useRef<(HTMLDivElement | null)[]>([]);
  const [onSeen] = useState(() =>
    SESSIONS.map((_, i) => () => {
      const past = els.current.map((e) => !!e && e.getBoundingClientRect().top < 0);
      setSt((p) => p.map((s, j) => (j === i && s === "idle" ? "seen" : j < i && s === "idle" && past[j] ? "skip" : s)));
    }),
  );
  const [onNext] = useState(() => SESSIONS.map((_, i) => () => setSt((p) => p.map((s, j) => (j === i && s === "seen" ? "handed" : s)))));
  const clear = (i: number) => st.slice(0, i).every((s) => s === "handed" || s === "skip");

  return (
    <Still.Provider value={still}>
      <section className="mx-auto max-w-[1100px] px-6 pb-32 pt-20 lg:pt-28">
        <div className="relative">
          {/* the threshold */}
          <div aria-hidden className="absolute bottom-0 left-1/2 top-0 hidden w-px -translate-x-1/2 bg-line-2 lg:block" />

          <div className={`${COLS} mb-12 hidden lg:grid`}>
            <Head className={LEFT} word="before" note="your claude code sessions" />
            <div className="flex justify-center">
              <span aria-hidden className="display relative bg-paper px-2.5 pt-1 text-[28px] leading-none">λ</span>
            </div>
            <Head className={RIGHT} word="after" note="what lambda draws from them" />
          </div>
          <p className="mb-10 text-center lg:hidden">
            <span className="display text-[26px] italic">before</span>
            <span className="mx-3 text-grey">→</span>
            <span className="display text-[26px] italic">after</span>
          </p>

          <div className="flex flex-col gap-16 lg:gap-12">
            {SESSIONS.map((_, i) => (
              <Row
                key={i}
                i={i}
                go={(st[i] === "seen" || st[i] === "handed") && clear(i)}
                skip={st[i] === "skip"}
                els={els}
                onSeen={onSeen[i]}
                onNext={onNext[i]}
              />
            ))}
          </div>
        </div>
      </section>
    </Still.Provider>
  );
}
