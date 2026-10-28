"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import clsx from "clsx";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ContextOp } from "@/lib/ops";
import type { ContextRef, Feature } from "@/lib/types";
import { KindIcon } from "../sources/bits";
import AddContextSheet, { type Draft } from "./AddContextSheet";

// Context as source lanes. Auto-discovered refs carry a relevance bar + a "why" chip; pinned refs survive
// rediscover. Everything here feeds generation via featurePrompt().

type Kind = ContextRef["kind"];
const LANES: { kind: Kind; label: string }[] = [
  { kind: "slack", label: "slack" },
  { kind: "linear", label: "linear" },
  { kind: "session", label: "past sessions" },
  { kind: "note", label: "notes" },
];
const SEARCHED: Kind[] = ["slack", "linear", "session"];

const normTitle = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const refId = (key: string) => `ctx-${key.replace(/[^\w-]/g, "-")}`.slice(0, 80);
const spring = { type: "spring", stiffness: 420, damping: 34 } as const;

// snippets come straight from linear / slack markdown: show prose, not syntax
export const plainSnippet = (s: string) =>
  s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<@?[A-Z0-9]+(\|[^>]+)?>/g, (m, label?: string) => (label ? label.slice(1) : "@someone"))
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(^|\s)(?:[-*+•]|\d+\.)\s+/g, "$1")
    .replace(/[*_~`>]{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim();

// legacy session refs were titled "(no prompt)": name them by where they ran
const displayTitle = (r: ContextRef) =>
  r.kind === "session" && /^\(no prompt\)$/.test(r.title.trim()) ? `session in ${r.excerpt.split(" · ")[0] || "a project"}` : r.title;
const order = (a: ContextRef, b: ContextRef) => Number(!!a.auto) - Number(!!b.auto) || (b.score ?? 1) - (a.score ?? 1);

export default function ContextTab({ feature, onChange }: { feature: Feature; onChange: (f: Feature) => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // latest feature, so rapid-fire optimistic edits don't clobber each other
  const latest = useRef(feature);
  useEffect(() => {
    latest.current = feature;
  }, [feature]);

  const set = useCallback(
    (patch: Partial<Feature>) => {
      const next = { ...latest.current, ...patch };
      latest.current = next;
      onChange(next);
    },
    [onChange],
  );
  const fail = (msg: string) => {
    setError(msg);
    window.setTimeout(() => setError((e) => (e === msg ? null : e)), 3200);
  };

  // server echo: take only context (other tabs may hold optimistic edits)
  const echo = useCallback((server: Feature) => set({ context: server.context }), [set]);

  const ops = useCallback(
    async (list: ContextOp[]) => {
      const res = await fetch(`/api/features/${feature.id}/ops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops: list }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const out = (await res.json()) as { feature: Feature };
      if (out.feature) echo(out.feature);
    },
    [feature.id, echo],
  );

  const add = useCallback(
    async (d: Draft, enrich?: () => Promise<Partial<Draft>>) => {
      const ref: ContextRef = { id: refId(d.key), kind: d.kind, title: d.title, excerpt: d.excerpt.slice(0, 400), url: d.url };
      if (latest.current.context.some((c) => c.id === ref.id)) return;
      set({ context: [...latest.current.context, ref] });
      try {
        const extra = enrich ? await enrich().catch(() => ({})) : {};
        const res = await fetch(`/api/features/${feature.id}/context`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...ref, ...extra }),
        });
        if (!res.ok) throw new Error();
        const server = (await res.json()) as Feature;
        const echoed = server.context.find((c) => c.id === ref.id);
        // merge just this ref, keeping other optimistic refs in flight
        set({ context: latest.current.context.map((c) => (c.id === ref.id && echoed ? echoed : c)) });
      } catch {
        set({ context: latest.current.context.filter((c) => c.id !== ref.id) });
        fail("couldn't attach");
      }
    },
    [feature.id, set],
  );

  const remove = useCallback(
    async (ref: ContextRef) => {
      set({ context: latest.current.context.filter((c) => c.id !== ref.id) });
      try {
        const res = await fetch(`/api/features/${feature.id}/context?refId=${encodeURIComponent(ref.id)}`, { method: "DELETE" });
        if (!res.ok) throw new Error();
      } catch {
        set({ context: [...latest.current.context, ref] });
        fail("couldn't remove");
      }
    },
    [feature.id, set],
  );

  // pin = attach what's already attached (contract: flips auto → false, keeps score + why)
  const pin = useCallback(
    async (ref: ContextRef) => {
      const flip = (auto: boolean) => set({ context: latest.current.context.map((c) => (c.id === ref.id ? { ...c, auto } : c)) });
      flip(false);
      try {
        await ops([{ op: "attach", kind: ref.kind, title: ref.title, excerpt: ref.excerpt, url: ref.url }]);
      } catch {
        flip(true);
        fail("couldn't pin");
      }
    },
    [ops, set],
  );

  const job = feature.jobs?.find((j) => j.kind === "context");
  const running = job?.status === "queued" || job?.status === "running";

  const rediscover = useCallback(async () => {
    const jobs = [...(latest.current.jobs ?? []).filter((j) => j.kind !== "context"), { kind: "context" as const, status: "queued" as const }];
    set({ jobs });
    try {
      const res = await fetch(`/api/features/${feature.id}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kinds: ["context"] }),
      });
      if (!res.ok) throw new Error();
      const server = (await res.json()) as Feature;
      set({ jobs: server.jobs }); // the workspace polls from here
    } catch {
      set({ jobs: latest.current.jobs?.filter((j) => j.kind !== "context") });
      fail("couldn't start discovery");
    }
  }, [feature.id, set]);

  const ctx = feature.context;
  const attached = new Set(ctx.map((c) => c.id));
  // matches refs this sheet attached (by source key) and auto-discovered ones (same kind + url, or same title)
  const attachedKeys = {
    has: (key: string, d?: Pick<ContextRef, "kind" | "title" | "url">) =>
      attached.has(refId(key)) ||
      (!!d && ctx.some((c) => c.kind === d.kind && ((!!d.url && c.url === d.url) || normTitle(c.title) === normTitle(d.title)))),
  };
  const lanes = LANES.filter((l) => l.kind !== "note" || ctx.some((c) => c.kind === "note"));
  const sourceCount = new Set(ctx.map((c) => c.kind)).size;

  return (
    <div>
      <Header
        feature={feature}
        found={ctx.length}
        sources={sourceCount}
        running={running}
        onRediscover={rediscover}
        onAdd={() => setOpen(true)}
      />

      <AnimatePresence>
        {(error || job?.status === "error") && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            className="mb-4 font-mono text-xs text-bad"
          >
            {error ?? `discovery failed · ${job?.error ?? ""}`}
          </motion.div>
        )}
      </AnimatePresence>

      {ctx.length === 0 && !running ? (
        <Empty searched={!!feature.discovery} onDiscover={rediscover} onAdd={() => setOpen(true)} />
      ) : (
        <div className={clsx("grid gap-4 sm:grid-cols-2", lanes.length === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3")}>
          {lanes.map((l, li) => (
            <Lane
              key={l.kind}
              kind={l.kind}
              label={l.label}
              refs={ctx.filter((c) => c.kind === l.kind).sort(order)}
              running={running && SEARCHED.includes(l.kind)}
              delay={li * 0.04}
              onRemove={remove}
              onPin={pin}
            />
          ))}
        </div>
      )}

      <AddContextSheet open={open} onClose={() => setOpen(false)} onAdd={add} attached={attachedKeys} />
    </div>
  );
}

// ---------- header: count · sources · per-source status · rediscover ----------

function Header({ feature, found, sources, running, onRediscover, onAdd }: {
  feature: Feature;
  found: number;
  sources: number;
  running: boolean;
  onRediscover: () => void;
  onAdd: () => void;
}) {
  const status = feature.discovery?.sources ?? [];
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="flex items-baseline gap-3">
        <span className="display text-5xl tabular-nums">{found}</span>
        <span className="font-mono text-[12px] text-grey">
          found · from {sources} source{sources === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {status.length > 0 && (
          <div className="mr-1 flex items-center gap-2.5 rounded-full border border-line px-3 py-1.5" aria-label="source status">
            {status.map((s) => (
              <span
                key={s.kind}
                title={s.ok ? `${s.kind}: ${s.found} searched` : `${s.kind}: ${s.error ?? "failed"}`}
                className="flex items-center gap-1.5 font-mono text-[11px] text-grey"
              >
                <span className={clsx("h-1.5 w-1.5 rounded-full", running ? "animate-pulse bg-grey" : s.ok ? "bg-ok" : "bg-bad")} />
                {s.kind === "session" ? "sessions" : s.kind}
              </span>
            ))}
          </div>
        )}
        <button className="btn btn-ghost !py-1.5 text-[13px]" onClick={onRediscover} disabled={running} title="search all sources again; pinned stay">
          <Spin on={running} /> {running ? "searching" : "rediscover"}
        </button>
        <button className="btn btn-primary !py-1.5 text-[13px]" onClick={onAdd}>
          + add
        </button>
      </div>
    </div>
  );
}

function Spin({ on }: { on: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      aria-hidden
      className={clsx(on && "animate-spin [animation-duration:0.8s]")}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M12.5 1.8v2.6H9.9" />
    </svg>
  );
}

// ---------- lanes ----------

function Lane({ kind, label, refs, running, delay, onRemove, onPin }: {
  kind: Kind;
  label: string;
  refs: ContextRef[];
  running: boolean;
  delay: number;
  onRemove: (r: ContextRef) => void;
  onPin: (r: ContextRef) => void;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.section
      initial={{ opacity: 0, y: reduce ? 0 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, delay, ease: [0.22, 1, 0.36, 1] }}
      className="flex min-w-0 flex-col gap-2 rounded-[20px] bg-paper-2/60 p-2"
    >
      <header className="flex items-center gap-2 px-2 pb-1 pt-1.5">
        <KindIcon kind={kind} size={18} />
        <span className="eyebrow !text-ink-2">{label}</span>
        <span className="ml-auto font-mono text-[11px] text-grey tabular-nums">{refs.length}</span>
      </header>
      <AnimatePresence initial={false} mode="popLayout">
        {refs.map((r) => (
          <RefCard key={r.id} r={r} onRemove={() => onRemove(r)} onPin={() => onPin(r)} />
        ))}
      </AnimatePresence>
      {running &&
        [0, 1].map((i) => <div key={i} className="shimmer h-[58px] rounded-[14px]" style={{ opacity: 1 - i * 0.35 }} aria-hidden />)}
      {!running && refs.length === 0 && (
        <div className="grid h-[58px] place-items-center rounded-[14px] border border-dashed border-line-2 font-mono text-[11px] text-grey">
          nothing relevant
        </div>
      )}
    </motion.section>
  );
}

function RefCard({ r, onRemove, onPin }: { r: ContextRef; onRemove: () => void; onPin: () => void }) {
  const [peek, setPeek] = useState(false);
  const reduce = useReducedMotion();
  const pinned = !r.auto;
  const score = r.score ?? (pinned ? 1 : 0);
  const title = displayTitle(r);
  const snippet = plainSnippet(r.excerpt ?? "");
  const expandable = !!(snippet || r.url);
  return (
    <motion.article
      data-focus-id={r.id}
      layout={reduce ? false : "position"}
      initial={{ opacity: 0, scale: reduce ? 1 : 0.97, y: reduce ? 0 : 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: reduce ? 1 : 0.96, transition: { duration: 0.14 } }}
      transition={spring}
      tabIndex={0}
      onClick={() => expandable && setPeek((p) => !p)}
      onKeyDown={(e) => e.key === "Enter" && expandable && setPeek((p) => !p)}
      aria-expanded={expandable ? peek : undefined}
      className={clsx(
        "group relative rounded-[14px] border border-line bg-card px-3 pb-2.5 pt-2.5 outline-none transition-[box-shadow,border-color] duration-200 focus-visible:ring-2 focus-visible:ring-lilac [@media(hover:hover)]:hover:shadow-[0_12px_28px_-18px_rgba(24,24,24,0.45)]",
        expandable ? "cursor-pointer" : "cursor-default",
        peek && "border-line-2",
      )}
    >
      <div className="flex items-center gap-2">
        <h3 className={clsx("min-w-0 flex-1 text-[13px] font-semibold leading-snug", peek ? "break-words" : "truncate")} title={title}>
          {title}
        </h3>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
          {!pinned && (
            <IconBtn label="pin — keeps it on rediscover" onClick={onPin}>
              <PinGlyph />
            </IconBtn>
          )}
          <IconBtn label="remove" onClick={onRemove} danger>
            ×
          </IconBtn>
        </div>
        {pinned && (
          <span className="shrink-0 text-ink-2" title="pinned">
            <PinGlyph filled />
          </span>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Bar value={score} muted={pinned && r.score == null} />
        {!(pinned && r.score == null) && (
          <span className="-ml-1 shrink-0 font-mono text-[10px] tabular-nums text-grey" title="relevance to this feature">
            {Math.round(score * 100)}
          </span>
        )}
        {r.why ? (
          <span className="min-w-0 truncate rounded-full bg-lilac-soft px-2 py-0.5 text-[11px] font-medium text-ink-2" title={r.why}>
            {r.why}
          </span>
        ) : (
          <span className="font-mono text-[10px] uppercase tracking-wider text-grey">{pinned ? "by hand" : "auto"}</span>
        )}
      </div>

      {/* click / enter: the excerpt opens in flow (height spring); the lane's cards glide down, nothing is covered */}
      <AnimatePresence initial={false}>
        {peek && expandable && (
          <motion.div
            key="peek"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0, transition: { duration: reduce ? 0 : 0.14, ease: [0.22, 1, 0.36, 1] } }}
            transition={reduce ? { duration: 0 } : { height: spring, opacity: { duration: 0.16 } }}
            className="overflow-hidden"
          >
            <div className="pt-2">
              {snippet && <p className="line-clamp-4 text-[12px] leading-relaxed text-ink-2">{snippet}</p>}
              {r.url && (
                <a
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="mt-1 inline-block font-mono text-[11px] text-blue hover:underline"
                >
                  open ↗
                </a>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );
}

function Bar({ value, muted }: { value: number; muted?: boolean }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span className="relative h-1 w-12 shrink-0 overflow-hidden rounded-full bg-paper-2" title={muted ? "pinned" : `relevance ${pct}%`}>
      <span
        className={clsx("absolute inset-y-0 left-0 rounded-full", muted ? "bg-line-2" : pct >= 75 ? "bg-ink" : "bg-ink-2/60")}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

function IconBtn({ label, onClick, danger, children }: { label: string; onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={clsx(
        "grid h-6 w-6 place-items-center rounded-full text-[13px] text-grey transition-[background-color,color,transform] duration-150 hover:bg-paper-2 active:scale-90",
        danger ? "hover:text-bad" : "hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function PinGlyph({ filled }: { filled?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M6 1.8h4l-.6 4.1 2.6 2.4v1.2H4v-1.2l2.6-2.4z" />
      <path d="M8 9.5v4.7" strokeLinecap="round" />
    </svg>
  );
}

// ---------- empty ----------

function Empty({ searched, onDiscover, onAdd }: { searched: boolean; onDiscover: () => void; onAdd: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="card relative flex min-h-[280px] items-center overflow-hidden px-8 py-12"
    >
      <div className="relative z-10 max-w-sm">
        <div className="eyebrow mb-3">slack · linear · past sessions</div>
        <h3 className="display text-4xl">{searched ? "nothing relevant yet" : "no context yet"}</h3>
        <div className="mt-6 flex flex-wrap gap-2">
          <button className="btn btn-primary" onClick={onDiscover}>
            <Spin on={false} /> {searched ? "search again" : "discover"}
          </button>
          <button className="btn btn-ghost" onClick={onAdd}>
            + add by hand
          </button>
        </div>
      </div>
      <Image
        src="/art/sage-compass.webp"
        alt=""
        width={900}
        height={1128}
        className="fade-b pointer-events-none absolute -bottom-4 right-2 h-[110%] w-auto select-none object-contain opacity-90 max-sm:opacity-30"
      />
    </motion.div>
  );
}
