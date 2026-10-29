"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";

// One at a time: a neat stack of claude code sessions on the left, one plate on the right.
// Every few seconds the stack turns over and the plate draws the matching picture.
// Demo feature only ("team invites", acme) — never real data.

const EASE = [0.22, 1, 0.36, 1] as const;
const DWELL = 5200;
const NUM = ["i", "ii", "iii"];

type Line = { k: "ask" | "tool" | "out" | "say"; t: string };
const PAIRS: { title: string; lines: Line[]; spin: string; said: string; fig: string }[] = [
  {
    title: "~/acme · invites",
    lines: [
      { k: "ask", t: "owners should invite teammates by email, with a role" },
      { k: "tool", t: "Read(src/app/settings/members/page.tsx)" },
      { k: "out", t: "Read 142 lines" },
      { k: "say", t: "Members needs an invite row and a pending list." },
    ],
    spin: "Sketching…",
    said: "the ask, in a session.",
    fig: "the members screen, marked up.",
  },
  {
    title: "~/acme · invite expiry",
    lines: [
      { k: "ask", t: "what happens if a link is opened after 7 days?" },
      { k: "tool", t: "Read(src/lib/invites/accept.ts)" },
      { k: "out", t: "Read 38 lines" },
      { k: "say", t: "Expired links need their own path, with resend." },
    ],
    spin: "Mapping…",
    said: "the question nobody wrote down.",
    fig: "the invite flow, expiry pinned.",
  },
  {
    title: "~/acme · resend & revoke",
    lines: [
      { k: "ask", t: "pending invites need resend and revoke" },
      { k: "tool", t: 'Search(pattern: "members", path: "db/")' },
      { k: "out", t: "Found 3 files" },
      { k: "say", t: "One new table: invites, tied to a workspace." },
    ],
    spin: "Drawing…",
    said: "the change, decided in passing.",
    fig: "one new table: invites.",
  },
];

export default function VC({ count }: { count: number }) {
  const still = !!useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const seen = useInView(ref, { once: true, margin: "-120px" });
  const [active, setActive] = useState(0);
  const [hold, setHold] = useState(false);

  // one timer per pair; clicking a tab restarts it
  useEffect(() => {
    if (still || !seen || hold) return;
    const t = setTimeout(() => setActive((a) => (a + 1) % 3), DWELL);
    return () => clearTimeout(t);
  }, [active, still, seen, hold]);

  const go = setActive;

  return (
    <section ref={ref} className="mx-auto max-w-7xl px-6 pb-28 pt-12">
      <header className="mb-14 flex items-end justify-between gap-6">
        <div>
          <h2 className="display text-[clamp(2.25rem,4.2vw,3.5rem)]">
            sessions in, <em>pictures</em> out.
          </h2>
          <p className="mt-4 max-w-xl font-serif text-[17px] italic leading-snug text-ink-2">
            lambda reads your claude code sessions and draws what they decided.
          </p>
        </div>
        <Link
          href="/features"
          className="shrink-0 pb-1 font-mono text-[13px] text-grey transition-colors hover:text-ink"
        >
          features {String(count).padStart(2, "0")} →
        </Link>
      </header>

      <div
        onMouseEnter={() => setHold(true)}
        onMouseLeave={() => setHold(false)}
        className="grid grid-cols-1 gap-y-6 lg:grid-cols-[1fr_88px_1fr] lg:grid-rows-[auto_auto] lg:gap-y-6"
      >
        {/* sessions */}
        <Stack active={active} still={still} />
        <Caption className="lg:col-start-1 lg:row-start-2" lead={`session ${NUM[active]}`} text={PAIRS[active].said} active={active} go={go} />

        {/* the threshold */}
        <Threshold active={active} still={still} />

        {/* the plate */}
        <div className="card relative aspect-[460/340] overflow-hidden lg:col-start-3 lg:row-start-1">
          {(seen || still) && (
            <AnimatePresence initial={false}>
              <motion.div
                key={active}
                className="absolute inset-0"
                initial={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.35, ease: EASE } }}
              >
                {active === 0 ? <Sketch still={still} /> : active === 1 ? <Flow still={still} /> : <Erd still={still} />}
              </motion.div>
            </AnimatePresence>
          )}
        </div>

        <Caption className="lg:col-start-3 lg:row-start-2" lead={`fig. ${NUM[active]}`} text={PAIRS[active].fig} active={active} go={go} />
      </div>
    </section>
  );
}

// three windows, front one legible; the others show only their title strips above it
const PEEK = 26;
function Stack({ active, still }: { active: number; still: boolean }) {
  return (
    <div className="relative flex min-h-[340px] flex-col lg:col-start-1 lg:row-start-1" style={{ paddingTop: PEEK * 2 }}>
      <div className="relative flex-1">
        {PAIRS.map((p, i) => {
          const pos = (i - active + 3) % 3;
          return (
            <motion.div
              key={i}
              aria-hidden={pos !== 0}
              className="card absolute inset-0 flex flex-col overflow-hidden"
              style={{ zIndex: 3 - pos, transformOrigin: "50% 0%" }}
              initial={false}
              animate={{ y: -pos * PEEK, scale: 1 - pos * 0.04, backgroundColor: pos ? "var(--paper)" : "var(--card)" }}
              transition={still ? { duration: 0 } : { type: "spring", stiffness: 120, damping: 22 }}
            >
              <div className="flex h-[26px] shrink-0 items-center gap-1.5 px-4 pt-0.5">
                {[0, 1, 2].map((d) => (
                  <span key={d} className="h-[7px] w-[7px] rounded-full border border-line-2" />
                ))}
                <span className="ml-3 font-mono text-[12px] text-grey">{p.title}</span>
              </div>
              <motion.div
                className="flex flex-1 flex-col border-t border-line px-5 pb-4 pt-5 font-mono text-[13px] leading-[1.7] sm:text-[14px] text-ink"
                initial={false}
                animate={{ opacity: pos ? 0 : 1 }}
                transition={{ duration: still ? 0 : 0.4, delay: pos || still ? 0 : 0.15 }}
              >
                <Session lines={p.lines} spin={p.spin} live={pos === 0} still={still} />
              </motion.div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function Session({ lines, spin, live, still }: { lines: Line[]; spin: string; live: boolean; still: boolean }) {
  return (
    <>
      {lines.map((l, i) => {
        if (l.k === "ask") return <p key={i} className="mb-3 text-ink-2"><span className="text-grey">&gt; </span>{l.t}</p>;
        if (l.k === "out") return <p key={i} className="whitespace-pre text-grey">{"  ⎿  "}{l.t}</p>;
        const say = l.k === "say";
        return (
          <p key={i} className={`relative pl-[2ch] -indent-[2ch] ${say ? "mt-2" : ""}`}>
            {/* the line lambda turns into a picture */}
            {say && (
              <motion.span
                aria-hidden
                className="absolute -inset-x-1.5 inset-y-0 -z-0 rounded bg-lilac-soft"
                initial={false}
                animate={{ opacity: live ? 1 : 0 }}
                transition={{ duration: still ? 0 : 0.8, delay: live && !still ? 0.7 : 0 }}
              />
            )}
            <span className="relative"><span className="text-ink-2">⏺ </span>{l.t}</span>
          </p>
        );
      })}
      <p className="mt-auto pt-5 text-[13px] text-grey">
        <span style={{ color: "#d97757" }}>✻</span> {spin} <span className="hidden sm:inline">(esc to interrupt)</span>
      </p>
      <div className="mt-2 rounded-lg border border-line-2 px-3 py-1.5 text-grey">
        &gt; <span className="inline-block h-[1.05em] w-[0.55em] translate-y-[0.15em] bg-line-2" />
      </div>
    </>
  );
}

// hairline + λ; a faint lilac mark crosses it each time the pair turns over
function Threshold({ active, still }: { active: number; still: boolean }) {
  return (
    <div aria-hidden className="relative my-6 flex items-center justify-center lg:my-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
      <span className="absolute inset-x-0 top-1/2 h-px bg-line-2 lg:inset-x-auto lg:inset-y-0 lg:left-1/2 lg:top-0 lg:h-auto lg:w-px" />
      <div className="relative lg:-mt-12">
        {!still && (
          <motion.span
            key={active}
            className="absolute left-1/2 top-1/2 h-[5px] w-[5px] -translate-y-1/2 rounded-full bg-lilac"
            initial={{ x: -64, opacity: 0 }}
            animate={{ x: [-64, 0, 64], opacity: [0, 1, 0] }}
            transition={{ duration: 1.1, delay: 0.35, ease: "easeInOut" }}
          />
        )}
        <span className="relative grid h-10 w-10 place-items-center rounded-full border border-line-2 bg-paper font-serif text-[20px] leading-none text-ink">
          λ
        </span>
      </div>
    </div>
  );
}

function Caption({ className, lead, text, active, go }: { className: string; lead: string; text: string; active: number; go: (i: number) => void }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 ${className}`}>
      <p className="min-w-0 font-serif text-[17px] italic text-ink-2">
        <span className="not-italic text-grey">{lead} — </span>
        {text}
      </p>
      <div className="flex shrink-0 gap-1" role="tablist">
        {NUM.map((n, i) => (
          <button
            key={n}
            role="tab"
            aria-selected={i === active}
            onClick={() => go(i)}
            className={`min-w-7 border-b px-1 pb-0.5 font-serif text-[17px] italic transition-colors ${
              i === active ? "border-ink text-ink" : "border-transparent text-grey hover:text-ink"
            }`}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------- plates: fine-line drawings, 460×340 ---------- */

const INK = "var(--ink)";
const L2 = "var(--line-2)";
const EDGE = "var(--ink-2)"; // outline weight for drawn shapes
const SANS = "var(--font-manrope), system-ui, sans-serif";
const MONO = "var(--font-inconsolata), ui-monospace, monospace";
const HAND = "var(--font-kalam), cursive";
const SERIF = "var(--font-stix), serif";

function Plate({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 460 340" className="h-full w-full" fill="none" strokeWidth={1}>
      {children}
    </svg>
  );
}

// strokes draw themselves in, text settles after; `at` orders the drawing
function useDraw(still: boolean) {
  const stroke = (at: number, dur = 0.7) =>
    still
      ? {}
      : {
          initial: { pathLength: 0, opacity: 0 },
          animate: { pathLength: 1, opacity: 1 },
          transition: { pathLength: { delay: 0.6 + at * 0.12, duration: dur, ease: EASE }, opacity: { delay: 0.6 + at * 0.12, duration: 0.01 } },
        };
  const fade = (at: number) =>
    still
      ? {}
      : { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { delay: 0.8 + at * 0.12, duration: 0.5, ease: EASE } };
  return { stroke, fade };
}

function Sketch({ still }: { still: boolean }) {
  const { stroke, fade } = useDraw(still);
  const rows = [
    { name: "Maya Chen", role: "owner" },
    { name: "Jon Reyes", role: "member" },
    { name: "lee@acme.dev", role: "pending · resend", soft: true },
  ];
  return (
    <Plate>
      {/* browser frame */}
      <motion.rect x={20} y={20} width={420} height={300} rx={10} stroke={L2} {...stroke(0, 1)} />
      <motion.path d="M20 48 H440" stroke="var(--line)" {...stroke(1)} />
      <motion.g {...fade(1)}>
        {[36, 48, 60].map((x) => <circle key={x} cx={x} cy={34} r={3} stroke={L2} />)}
        <text x={230} y={38} textAnchor="middle" fontFamily={MONO} fontSize={12} fill="var(--grey)">acme.app/settings/members</text>
      </motion.g>

      <motion.g {...fade(2)}>
        <text x={44} y={90} fontFamily={SANS} fontSize={20} fontWeight={600} fill={INK}>Members</text>
        {/* invite row */}
        <rect x={44} y={108} width={180} height={36} rx={6} stroke={L2} />
        <text x={58} y={131} fontFamily={SANS} fontSize={14} fill="var(--grey)">name@acme.dev</text>
        <rect x={234} y={108} width={96} height={36} rx={6} stroke={L2} />
        <text x={248} y={131} fontFamily={SANS} fontSize={14} fill={INK}>member</text>
        <path d="M309 124 l4 4 l4 -4" stroke="var(--grey)" />
        <rect x={340} y={108} width={76} height={36} rx={6} stroke={EDGE} />
        <text x={378} y={131} textAnchor="middle" fontFamily={SANS} fontSize={14} fill={INK}>invite</text>
      </motion.g>

      {rows.map((r, i) => {
        const y = 182 + i * 44;
        return (
          <motion.g key={r.name} {...fade(3 + i)}>
            <path d={`M44 ${y - 22} H416`} stroke="var(--line)" />
            <circle cx={56} cy={y} r={11} fill={r.soft ? "none" : "var(--paper-2)"} stroke={L2} strokeDasharray={r.soft ? "2 3" : undefined} />
            <text x={78} y={y + 5} fontFamily={SANS} fontSize={14} fill={r.soft ? "var(--grey)" : INK}>{r.name}</text>
            <text x={416} y={y + 5} textAnchor="end" fontFamily={SANS} fontSize={13.5} fill="var(--grey)">{r.role}</text>
          </motion.g>
        );
      })}

      {/* the one marker note */}
      <motion.path
        d="M228 128 C224 106 268 100 296 101 C328 103 344 113 342 129 C340 148 300 155 266 152 C242 150 226 141 231 122"
        stroke="var(--marker)"
        strokeWidth={2}
        strokeLinecap="round"
        {...(still ? {} : { initial: { pathLength: 0 }, animate: { pathLength: 1 }, transition: { delay: 1.5, duration: 0.8, ease: EASE } })}
      />
      <motion.text x={262} y={86} fontFamily={HAND} fontSize={18} fill="var(--marker)" {...fade(8)}>
        default to member
      </motion.text>
    </Plate>
  );
}

const NH = 36;
function Node({ x, y, w, label, at, still, pin }: { x: number; y: number; w: number; label: string; at: number; still: boolean; pin?: boolean }) {
  const { stroke, fade } = useDraw(still);
  return (
    <g>
      {pin && <motion.rect x={x} y={y} width={w} height={NH} rx={8} fill="var(--lilac-soft)" stroke="none" {...fade(at)} />}
      <motion.rect x={x} y={y} width={w} height={NH} rx={8} stroke={pin ? "var(--lilac)" : EDGE} {...stroke(at)} />
      <motion.text x={x + w / 2} y={y + 23} textAnchor="middle" fontFamily={SANS} fontSize={14} fill={INK} {...fade(at)}>
        {label}
      </motion.text>
    </g>
  );
}

function Flow({ still }: { still: boolean }) {
  const { stroke, fade } = useDraw(still);
  const cx = 156;
  const w = 152;
  const arrow = (d: string, at: number) => <motion.path d={d} stroke={L2} markerEnd="url(#vc-arrow)" {...stroke(at, 0.4)} />;
  const note = { fontFamily: SERIF, fontStyle: "italic", fontSize: 15, fill: "var(--grey)" } as const;
  return (
    <Plate>
      <defs>
        <marker id="vc-arrow" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto">
          <path d="M1 1 L7 4 L1 7" fill="none" stroke="var(--grey)" />
        </marker>
      </defs>
      <Node x={cx - w / 2} y={16} w={w} label="owner invites" at={0} still={still} />
      {arrow(`M${cx} 52 V76`, 1)}
      <Node x={cx - w / 2} y={78} w={w} label="email with link" at={1.5} still={still} />
      {arrow(`M${cx} 114 V138`, 2.5)}
      <Node x={cx - w / 2} y={140} w={w} label="opens link" at={3} still={still} />
      {arrow(`M${cx} 176 V196`, 4)}
      {/* decision */}
      <motion.path d={`M${cx} 198 L${cx + 74} 232 L${cx} 266 L${cx - 74} 232 Z`} stroke={EDGE} {...stroke(4.5)} />
      <motion.text x={cx} y={237} textAnchor="middle" fontFamily={SANS} fontSize={14} fill={INK} {...fade(4.5)}>
        within 7 days?
      </motion.text>
      {arrow(`M${cx} 266 V286`, 5.5)}
      <Node x={cx - w / 2} y={288} w={w} label="joins with role" at={6} still={still} />
      {arrow(`M${cx + 74} 232 H292`, 6)}
      <Node x={294} y={214} w={144} label="link expired" at={7} still={still} pin />
      {/* resend loops back to the email */}
      <motion.path d={`M366 214 V96 H${cx + w / 2 + 2}`} stroke={L2} strokeDasharray="3 4" markerEnd="url(#vc-arrow)" {...stroke(8, 0.8)} />
      <motion.g {...fade(8)}>
        <text x={cx + 10} y={281} {...note}>yes</text>
        <text x={260} y={224} textAnchor="middle" {...note}>no</text>
        <text x={374} y={160} {...note}>resend</text>
        <text x={366} y={274} textAnchor="middle" {...note} fill="var(--ink-2)">edge case i</text>
      </motion.g>
    </Plate>
  );
}

type Col = [string, string];
const TW = 172;
const ROW = (y: number, i: number) => y + 54 + i * 28; // centre of column i
function Table({ x, y, name, cols, at, still, fresh }: { x: number; y: number; name: string; cols: Col[]; at: number; still: boolean; fresh?: boolean }) {
  const { stroke, fade } = useDraw(still);
  const h = 36 + cols.length * 28 + 8;
  const edge = fresh ? "var(--lilac)" : EDGE;
  return (
    <g>
      {fresh && <motion.path d={`M${x} ${y + 36} V${y + 8} Q${x} ${y} ${x + 8} ${y} H${x + TW - 8} Q${x + TW} ${y} ${x + TW} ${y + 8} V${y + 36} Z`} fill="var(--lilac-soft)" {...fade(at)} />}
      <motion.rect x={x} y={y} width={TW} height={h} rx={8} stroke={edge} {...stroke(at, 0.9)} />
      <motion.path d={`M${x} ${y + 36} H${x + TW}`} stroke={fresh ? edge : L2} {...stroke(at + 0.5)} />
      <motion.g {...fade(at + 0.5)}>
        <text x={x + 14} y={y + 24} fontFamily={SERIF} fontSize={17} fill={INK}>{name}</text>
        {fresh && <text x={x + TW - 14} y={y + 24} textAnchor="end" fontFamily={SERIF} fontStyle="italic" fontSize={15} fill="var(--ink-2)">new</text>}
        {cols.map(([c, t], i) => (
          <g key={c}>
            <text x={x + 14} y={ROW(y, i) + 5} fontFamily={SANS} fontSize={14} fill="var(--ink-2)">{c}</text>
            <text x={x + TW - 14} y={ROW(y, i) + 4} textAnchor="end" fontFamily={MONO} fontSize={12.5} fill="var(--grey)">{t}</text>
          </g>
        ))}
      </motion.g>
    </g>
  );
}

function Erd({ still }: { still: boolean }) {
  const { stroke } = useDraw(still);
  const ws = { x: 30, y: 24 };
  const mb = { x: 30, y: 192 };
  const inv = { x: 262, y: 60 };
  return (
    <Plate>
      <Table {...ws} name="workspaces" cols={[["id", "uuid"], ["name", "text"]]} at={0} still={still} />
      <Table {...mb} name="members" cols={[["id", "uuid"], ["workspace_id", "uuid"], ["role", "text"]]} at={1.5} still={still} />
      <Table {...inv} name="invites" fresh at={3} still={still} cols={[["id", "uuid"], ["workspace_id", "uuid"], ["email", "citext"], ["role", "text"], ["expires_at", "timestamptz"], ["invited_by", "uuid"]]} />
      {/* relations */}
      <motion.path d={`M${inv.x} ${ROW(inv.y, 1)} H232 V${ROW(ws.y, 0)} H${ws.x + TW}`} stroke={L2} {...stroke(6, 0.8)} />
      <motion.path d={`M${inv.x} ${ROW(inv.y, 5)} H232 V${ROW(mb.y, 0)} H${mb.x + TW}`} stroke={L2} {...stroke(6.5, 0.8)} />
      <motion.path d={`M${mb.x} ${ROW(mb.y, 1)} H16 V${ROW(ws.y, 0)} H${ws.x}`} stroke={L2} {...stroke(7, 0.8)} />
    </Plate>
  );
}
