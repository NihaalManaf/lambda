"use client";

import Link from "next/link";
import { useRef, type ReactNode } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";

// Paired rows: each claude code session on the left, the picture lambda drew from it on the right,
// the threshold line between them. Cause → effect reads straight across, row by row.

const EASE = [0.22, 1, 0.36, 1] as const;
const CORAL = "#d97757"; // claude's ✻, nowhere else
const SHADOW = "0 1px 0 rgba(24,24,24,0.02), 0 24px 48px -32px rgba(24,24,24,0.22)";

type Beat = { on: boolean; still: boolean };
// one timing helper so reduced motion collapses every step to its final state
const at = ({ still }: Beat, delay: number, duration = 0.7) => (still ? { duration: 0 } : { delay, duration, ease: EASE });

/* ── claude code ───────────────────────────────────────── */

type Ln = { k: "prompt" | "tool" | "out" | "say"; t: string; arg?: string };

function Terminal({ lines, busy, beat }: { lines: Ln[]; busy: string; beat: Beat }) {
  return (
    <div className="card flex h-full flex-col overflow-hidden" style={{ boxShadow: SHADOW }}>
      <div className="relative flex h-9 items-center gap-1.5 border-b border-line px-4">
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-[7px] rounded-full bg-line-2" />
        ))}
        <span className="absolute inset-x-0 text-center font-mono text-[12px] text-grey">~/acme — claude</span>
      </div>
      <div className="flex flex-1 flex-col px-4 py-5 font-mono text-[13px] leading-[1.75] text-ink sm:px-6 sm:text-[13.5px]">
        {lines.map((l, i) => {
          if (l.k === "prompt")
            return (
              <div key={i} className="relative mb-3 grid w-fit max-w-full grid-cols-[2ch_1fr]">
                <motion.span
                  aria-hidden
                  className="absolute -inset-x-2 inset-y-0 origin-left rounded-[4px] bg-lilac-soft"
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: beat.on ? 1 : 0 }}
                  transition={at(beat, 0.55, 0.6)}
                />
                <span className="relative text-grey">&gt;</span>
                <span className="relative">{l.t}</span>
              </div>
            );
          if (l.k === "out")
            return (
              <div key={i} className="grid grid-cols-[2ch_3ch_1fr] text-grey">
                <span />
                <span>⎿</span>
                <span>{l.t}</span>
              </div>
            );
          return (
            <div key={i} className={`grid grid-cols-[2ch_1fr] ${i > 1 ? "mt-2" : ""}`}>
              <span>⏺</span>
              {l.k === "tool" ? (
                <span>
                  <span className="font-semibold">{l.t}</span>
                  <span className="text-ink-2">({l.arg})</span>
                </span>
              ) : (
                <span className="text-ink-2">{l.t}</span>
              )}
            </div>
          );
        })}
        <div className="mt-3 grid grid-cols-[2ch_1fr] text-grey">
          <span style={{ color: CORAL }}>✻</span>
          <span>{busy}</span>
        </div>
        <div className="mt-auto pt-6">
          <div className="rounded-[6px] border border-line px-3 py-1.5 text-grey">&gt;</div>
        </div>
      </div>
    </div>
  );
}

/* ── fig. i — ui sketch ────────────────────────────────── */

function Person({ name, sub, role, pending }: { name: string; sub?: string; role: ReactNode; pending?: boolean }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <span className={`size-6 shrink-0 rounded-full border ${pending ? "border-dashed border-line-2" : "border-line-2 bg-paper-2"}`} />
      <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
        {name}
        {sub && <span className="block text-[12px] text-grey">{sub}</span>}
      </span>
      <span className="text-[13px] text-grey">{role}</span>
    </div>
  );
}

function Sketch({ beat }: { beat: Beat }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: beat.on ? 1 : 0 }} transition={at(beat, 1.6, 0.8)} className="overflow-hidden rounded-[10px] border border-line-2">
      <div className="flex h-8 items-center border-b border-line bg-paper px-3">
        <span className="font-mono text-[12px] text-grey">acme.app/settings/members</span>
      </div>
      <div className="px-5 pb-4 pt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-serif text-[20px] leading-none">members</span>
          <span className="rounded-full border border-ink px-3 py-0.5 text-[12px]">invite</span>
        </div>
        <div className="divide-y divide-line">
          <Person name="Lee Novak" role="admin" />
          <Person name="Ravi Kim" role="member" />
        </div>
        <p className="eyebrow mb-0.5 mt-4">pending</p>
        <div className="relative">
          <Person
            pending
            name="sam@acme.dev"
            sub="expires in 6 days"
            role={
              <span className="relative inline-flex items-center gap-7">
                <span className="relative text-ink">
                  resend
                  {/* the one marker note */}
                  <svg aria-hidden viewBox="0 0 80 36" preserveAspectRatio="none" className="pointer-events-none absolute -left-[13px] -top-[9px] h-[38px] w-[74px] overflow-visible">
                    <motion.path
                      d="M8 20 C 6 8, 40 3, 66 8 C 82 12, 78 30, 50 32 C 28 34, 4 30, 10 16"
                      fill="none"
                      stroke="var(--marker)"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      initial={{ pathLength: 0 }}
                      animate={{ pathLength: beat.on ? 1 : 0 }}
                      transition={at(beat, 2.3, 0.8)}
                    />
                  </svg>
                </span>
                <span>revoke</span>
              </span>
            }
          />
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: beat.on ? 1 : 0 }}
            transition={at(beat, 3, 0.6)}
            className="mt-1 text-right font-hand text-[15px] leading-none text-marker"
          >
            same role, fresh 7-day link
          </motion.p>
        </div>
      </div>
    </motion.div>
  );
}

/* ── fig. ii — flowchart ───────────────────────────────── */

// same five shapes in two arrangements: wide (one row + a branch) and tall (for narrow cards),
// so labels never shrink below ~13px
type Geo = {
  box: string;
  id: string;
  a: [number, number]; b: [number, number]; c: [number, number]; // node top-left corners (140×44)
  dia: [number, number]; // diamond centre
  d: [number, number]; // edge-case node top-left (108×60)
  edges: string[]; // ab, b→dia, dia→no, dia→yes
  no: [number, number]; yes: [number, number]; note: [number, number];
};
const WIDE: Geo = {
  box: "0 0 480 210",
  id: "vb-arrow-w",
  a: [10, 24], b: [200, 24], c: [10, 132], dia: [270, 154], d: [364, 124],
  edges: ["M150 46 H196", "M270 68 V112", "M214 154 H154", "M326 154 H360"],
  no: [184, 145], yes: [343, 145], note: [418, 108],
};
const TALL: Geo = {
  box: "0 0 300 352",
  id: "vb-arrow-t",
  a: [80, 4], b: [80, 82], c: [0, 270], dia: [150, 196], d: [176, 262],
  edges: ["M150 48 V78", "M150 126 V154", "M94 196 H70 V266", "M206 196 H230 V258"],
  no: [80, 186], yes: [220, 186], note: [230, 344],
};

function FlowSvg({ g, beat, className }: { g: Geo; beat: Beat; className: string }) {
  const draw = (d: number) => ({ initial: { pathLength: 0 }, animate: { pathLength: beat.on ? 1 : 0 }, transition: at(beat, d, 0.5) });
  const show = (d: number) => ({ initial: { opacity: 0 }, animate: { opacity: beat.on ? 1 : 0 }, transition: at(beat, d, 0.5) });
  const serif = { fontFamily: "var(--font-serif)", fontStyle: "italic", fill: "var(--grey)" } as const;
  const node = ([x, y]: [number, number], label: string, d: number) => (
    <motion.g {...show(d)}>
      <rect x={x} y={y} width={140} height={44} rx={10} fill="var(--card)" stroke="var(--ink)" />
      <text x={x + 70} y={y + 27} textAnchor="middle">
        {label}
      </text>
    </motion.g>
  );
  const edge = (i: number, d: number) => <motion.path d={g.edges[i]} stroke="var(--ink)" fill="none" markerEnd={`url(#${g.id})`} {...draw(d)} />;
  const [cx, cy] = g.dia;
  const [dx, dy] = g.d;
  return (
    <svg viewBox={g.box} className={className} style={{ fontFamily: "var(--font-sans)", fontSize: 14, fill: "var(--ink)" }}>
      <defs>
        <marker id={g.id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto">
          <path d="M1 1 L7 4 L1 7" fill="none" stroke="var(--ink)" strokeWidth="1" />
        </marker>
      </defs>
      {node(g.a, "owner invites", 1.6)}
      {edge(0, 1.9)}
      {node(g.b, "opens the link", 2.1)}
      {edge(1, 2.4)}
      <motion.g {...show(2.6)}>
        <path d={`M${cx} ${cy - 38} L${cx + 56} ${cy} L${cx} ${cy + 38} L${cx - 56} ${cy} Z`} fill="var(--card)" stroke="var(--ink)" />
        <text x={cx} y={cy + 5} textAnchor="middle">
          expired?
        </text>
      </motion.g>
      {edge(2, 2.9)}
      <motion.text {...show(2.9)} x={g.no[0]} y={g.no[1]} textAnchor="middle" style={serif}>
        no
      </motion.text>
      {node(g.c, "joins workspace", 3.1)}
      {edge(3, 3.3)}
      <motion.text {...show(3.3)} x={g.yes[0]} y={g.yes[1]} textAnchor="middle" style={serif}>
        yes
      </motion.text>
      {/* the pinned edge case */}
      <motion.g {...show(3.5)}>
        <rect x={dx} y={dy} width={108} height={60} rx={10} fill="var(--lilac-soft)" stroke="var(--lilac)" />
        <text x={dx + 54} y={dy + 26} textAnchor="middle">
          asks owner
        </text>
        <text x={dx + 54} y={dy + 44} textAnchor="middle">
          to resend
        </text>
        <circle cx={dx + 108} cy={dy} r={4} fill="var(--lilac)" stroke="var(--ink)" strokeWidth={0.75} />
        <text x={g.note[0]} y={g.note[1]} textAnchor="middle" style={serif}>
          edge case
        </text>
      </motion.g>
    </svg>
  );
}

function Flow({ beat }: { beat: Beat }) {
  return (
    <>
      <FlowSvg g={WIDE} beat={beat} className="mx-auto hidden w-full max-w-[480px] sm:block lg:hidden xl:block" />
      <FlowSvg g={TALL} beat={beat} className="mx-auto block w-full max-w-[300px] sm:hidden lg:block xl:hidden" />
    </>
  );
}

/* ── fig. iii — schema ─────────────────────────────────── */

const ROW = "flex h-8 items-center justify-between gap-3 px-3 text-[13px]";

function Table({ name, cols, fresh }: { name: string; cols: [string, string][]; fresh?: boolean }) {
  return (
    <div className={`min-w-0 overflow-hidden rounded-[10px] border bg-card ${fresh ? "border-lilac" : "border-line-2"}`}>
      <div className={`flex h-10 items-center justify-between border-b px-3 ${fresh ? "border-lilac bg-lilac-soft/50" : "border-line"}`}>
        <span className="font-serif text-[16px]">{name}</span>
        {fresh && <span className="font-serif text-[13px] italic text-grey">new</span>}
      </div>
      {cols.map(([c, t]) => (
        <div key={c} className={ROW}>
          <span className="truncate text-ink-2">{c}</span>
          <span className="hidden text-grey sm:inline lg:hidden xl:inline">{t}</span>
        </div>
      ))}
    </div>
  );
}

function Schema({ beat }: { beat: Beat }) {
  return (
    <div className="mx-auto flex max-w-[460px] items-start">
      <motion.div className="mt-8 w-[42%] shrink-0" initial={{ opacity: 0 }} animate={{ opacity: beat.on ? 1 : 0 }} transition={at(beat, 1.6)}>
        <Table name="workspaces" cols={[["id", "uuid"], ["name", "text"], ["owner_id", "uuid"]]} />
      </motion.div>
      {/* workspaces.id 1 ── < invites.workspace_id; both rows sit 88px down */}
      <div className="relative w-6 shrink-0 self-stretch sm:w-10">
        <svg aria-hidden className="absolute left-0 top-[82px] h-3 w-full overflow-visible" preserveAspectRatio="none">
          <motion.line x1="0" y1="6" x2="100%" y2="6" stroke="var(--ink)" initial={{ pathLength: 0 }} animate={{ pathLength: beat.on ? 1 : 0 }} transition={at(beat, 2.2, 0.5)} />
        </svg>
        <motion.svg aria-hidden viewBox="0 0 8 12" className="absolute right-0 top-[82px] h-3 w-2" initial={{ opacity: 0 }} animate={{ opacity: beat.on ? 1 : 0 }} transition={at(beat, 2.6, 0.4)}>
          <path d="M0 6 L8 0 M0 6 L8 6 M0 6 L8 12" stroke="var(--ink)" fill="none" />
        </motion.svg>
      </div>
      <motion.div className="min-w-0 flex-1" initial={{ opacity: 0, y: 6 }} animate={{ opacity: beat.on ? 1 : 0, y: beat.on ? 0 : 6 }} transition={at(beat, 2.6, 0.8)}>
        <Table
          fresh
          name="invites"
          cols={[["id", "uuid"], ["workspace_id", "uuid"], ["email", "text"], ["role", "role"], ["expires_at", "timestamptz"]]}
        />
      </motion.div>
    </div>
  );
}

/* ── rows ──────────────────────────────────────────────── */

const ROWS: { n: string; session: string; fig: string; lines: Ln[]; busy: string; Art: (p: { beat: Beat }) => ReactNode }[] = [
  {
    n: "i",
    session: "session — the members page",
    fig: "fig. i — members, marked up",
    lines: [
      { k: "prompt", t: "let owners invite teammates by email" },
      { k: "tool", t: "Read", arg: "app/settings/members/page.tsx" },
      { k: "out", t: "Read 112 lines" },
      { k: "say", t: "Pending invites go under the list, each with resend." },
    ],
    busy: "Sketching…",
    Art: Sketch,
  },
  {
    n: "ii",
    session: "session — when a link expires",
    fig: "fig. ii — accepting an invite",
    lines: [
      { k: "prompt", t: "what if someone opens it after 7 days?" },
      { k: "tool", t: "Grep", arg: '"expires_at"' },
      { k: "out", t: "Found 3 files" },
      { k: "say", t: "Today it throws. It should ask the owner to resend." },
    ],
    busy: "Mapping…",
    Art: Flow,
  },
  {
    n: "iii",
    session: "session — the migration",
    fig: "fig. iii — the invites table",
    lines: [
      { k: "prompt", t: "add the table for pending invites" },
      { k: "tool", t: "Write", arg: "db/migrations/0042_invites.sql" },
      { k: "out", t: "Wrote 14 lines" },
      { k: "say", t: "One invite per email, tied to a workspace and a role." },
    ],
    busy: "Migrating…",
    Art: Schema,
  },
];

const Caption = ({ children }: { children: ReactNode }) => <p className="mt-4 font-serif text-[15px] italic text-grey">{children}</p>;

function Row({ row }: { row: (typeof ROWS)[number] }) {
  const ref = useRef<HTMLDivElement>(null);
  const still = !!useReducedMotion();
  const seen = useInView(ref, { once: true, margin: "0px 0px -25% 0px" });
  const beat = { on: still || seen, still };
  const { Art } = row;

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 28 }}
      animate={{ opacity: beat.on ? 1 : 0, y: beat.on ? 0 : 28 }}
      transition={still ? { duration: 0 } : { opacity: { duration: 0.9 }, y: { type: "spring", stiffness: 80, damping: 20 } }}
      className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_128px_minmax(0,1fr)]"
    >
      <div className="flex flex-col">
        <div className="flex-1">
          <Terminal lines={row.lines} busy={row.busy} beat={beat} />
        </div>
        <Caption>{row.session}</Caption>
      </div>

      {/* threshold: numeral on the line, one lilac mark crossing it (desktop); a hairline divider when stacked */}
      <div className="relative hidden lg:block">
        <span className="absolute left-1/2 top-[6px] -translate-x-1/2 bg-paper px-1 py-1.5 font-serif text-[17px] italic leading-none text-ink">{row.n}</span>
        <motion.span
          aria-hidden
          className="absolute top-[calc(50%-24px)] h-px w-7 bg-gradient-to-r from-transparent to-lilac"
          initial={{ left: "-12%", opacity: 0 }}
          animate={beat.on && !still ? { left: ["-12%", "100%"], opacity: [0, 1, 1, 0] } : { left: "100%", opacity: 0 }}
          transition={still ? { duration: 0 } : { delay: 1.0, duration: 1.1, ease: "easeInOut" }}
        />
      </div>
      <div className="flex items-center gap-4 py-8 lg:hidden">
        <span className="h-px flex-1 bg-line-2" />
        <span className="font-serif text-[17px] italic text-ink">{row.n}</span>
        <span className="h-px flex-1 bg-line-2" />
      </div>

      <div className="flex flex-col">
        <div className="card flex flex-1 items-center p-4 sm:p-7" style={{ boxShadow: SHADOW }}>
          <div className="w-full">
            <Art beat={beat} />
          </div>
        </div>
        <Caption>{row.fig}</Caption>
      </div>
    </motion.div>
  );
}

export default function VB({ count }: { count: number }) {
  return (
    <section className="mx-auto max-w-[1280px] px-6 pb-32 pt-24">
      <header className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
        <div>
          <p className="eyebrow mb-5">λ — how it reads</p>
          <h2 className="display text-[clamp(2.25rem,4.4vw,3.75rem)]">
            sessions in, <em>pictures</em> out.
          </h2>
          <p className="mt-6 max-w-[44ch] text-[15px] leading-relaxed text-ink-2">
            every claude code session leaves decisions behind. lambda reads them and draws each one back, so you check a picture, not a transcript.
          </p>
        </div>
        <Link href="/features" className="font-mono text-[13px] text-grey transition-colors hover:text-ink">
          features {String(count).padStart(2, "0")} →
        </Link>
      </header>

      <div className="relative mt-20">
        {/* the threshold, full height */}
        <div aria-hidden className="absolute bottom-10 left-1/2 top-12 hidden w-px -translate-x-1/2 bg-line-2 lg:block" />
        <div className="mb-8 hidden grid-cols-[minmax(0,1fr)_128px_minmax(0,1fr)] items-baseline lg:grid">
          <p className="eyebrow">claude code</p>
          <p className="display text-center text-[26px]">λ</p>
          <p className="eyebrow">lambda</p>
        </div>
        <div className="space-y-16 lg:space-y-28">
          {ROWS.map((r) => (
            <Row key={r.n} row={r} />
          ))}
        </div>
      </div>
    </section>
  );
}
