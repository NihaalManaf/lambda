"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "motion/react";
import clsx from "clsx";
import type { StoryOp } from "@/lib/ops";
import type { FeatureView, Priority, Story } from "@/lib/types";
import { focusTab, storiesApi, type FocusDetail } from "./api";
import { notify } from "@/lib/desktop";
import { sortPieces } from "@/lib/pieces";
import { hoverPiece, pieceAction, pieceAt } from "@/components/pieces/api";
import { Meter, PRIORITIES, lastRun, liveOf, type Live } from "./bits";
import { QuickAdd } from "./Compose";
import StoryDetail from "./StoryDetail";
import StoryTile, { tileSpring } from "./StoryTile";
import Scribe from "@/components/Scribe";
import { UNDO_MS, useStoryOps } from "./useStoryOps";

type Col = {
  id: string;
  title: string;
  n?: number;
  match: (s: Story) => boolean;
  drop: { priority?: Priority };
  seed: { priority?: Priority };
};
type Pt = { x: number; y: number };

// Column under a page-coord point. Tiles are skipped: the dragged tile sits on top of the stack but still lives
// in its source column, so reading its column would always answer "where it came from".
function colAt(p: Pt): string | null {
  const els = document.elementsFromPoint(p.x - window.scrollX, p.y - window.scrollY);
  for (const el of els) {
    if ((el as HTMLElement).closest?.("[data-story]")) continue;
    const c = (el as HTMLElement).closest?.("[data-col]");
    if (c) return c.getAttribute("data-col");
  }
  return null;
}

export default function StoriesTab({ feature, onChange }: { feature: FeatureView; onChange: (f: FeatureView) => void }) {
  const [busy, setBusy] = useState<"generate" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [compose, setCompose] = useState<string | null>(null); // column id with the quick-add open
  const [pulse, setPulse] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  const fid = feature.id;
  const ops = useStoryOps(feature, onChange, setErr);
  const { send, keyOf, realOf, hidden } = ops;
  const op = useCallback((o: StoryOp) => void send([o]), [send]);

  const stories = useMemo(() => feature.stories.filter((s) => !hidden.has(s.id)), [feature.stories, hidden]);
  // the background "stories" job (auto-generation on create) drives the same loader as a manual generate
  const storiesJob = feature.jobs?.find((j) => j.kind === "stories");
  const jobBusy = storiesJob?.status === "queued" || storiesJob?.status === "running";
  // stories wait on the facts session reading the code first
  const factsJob = feature.jobs?.find((j) => j.kind === "facts");
  const reading = storiesJob?.status === "queued" && (factsJob?.status === "queued" || factsJob?.status === "running");
  const live = useMemo(() => {
    const m = new Map<string, Live>();
    for (const s of feature.stories) m.set(s.id, liveOf(s, lastRun(feature, s.id)));
    return m;
  }, [feature]);
  // most common role seeds the quick-add
  const role = useMemo(() => {
    const c = new Map<string, number>();
    for (const s of feature.stories) c.set(s.role, (c.get(s.role) ?? 0) + 1);
    return [...c].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "user";
  }, [feature.stories]);

  // a regenerate asked here: say so when its background job lands
  const asked = useRef(false);
  useEffect(() => {
    if (!asked.current || (storiesJob?.status !== "done" && storiesJob?.status !== "error")) return;
    asked.current = false;
    if (storiesJob.status === "done") notify("stories ready", `${feature.stories.length} tiles for ${feature.title}`);
  }, [storiesJob?.status, storiesJob?.finishedAt, feature.stories.length, feature.title]);

  const run = async (kind: "generate") => {
    asked.current = true;
    setBusy(kind);
    setErr(null);
    try {
      // a background job now (facts first when missing, checked against the code after): the poll brings them
      const f = await storiesApi.generate(fid, feature.pieceId);
      onChange(f);
    } catch (e) {
      asked.current = false;
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const removeStory = (s: Story) => {
    setOpen(null);
    ops.removeLater(`story · ${s.want.split(" ").slice(0, 4).join(" ")}`, [{ op: "remove_story", storyId: s.id }], [s.id]);
  };

  const verify = async (s: Story) => {
    setStarting(s.id);
    try {
      const { feature: f, runId } = await storiesApi.verify(fid, realOf(s.id));
      onChange(f);
      setOpen(null);
      focusTab({ tab: "verify", ref: runId });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setStarting(null);
    }
  };

  // chat change cards / links: {tab:'stories', ref: storyId | sliceId} → scroll + pulse
  const pulseTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<FocusDetail>).detail;
      if (d?.tab !== "stories" || !d.ref) return;
      const ref = d.ref;
      let tries = 0;
      const find = () => {
        const sel = `[data-story="${CSS.escape(ref)}"],[data-story-key="${CSS.escape(ref)}"],[data-col="${CSS.escape(ref)}"]`;
        const el = document.querySelector<HTMLElement>(sel);
        if (!el || !el.offsetParent) return ++tries < 30 && requestAnimationFrame(find); // wait for the feature / tab to land
        el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center", inline: "center" });
        setPulse(ref);
        clearTimeout(pulseTimer.current);
        pulseTimer.current = setTimeout(() => setPulse(null), 1700);
      };
      requestAnimationFrame(find);
    };
    window.addEventListener("lambda:focus", on);
    return () => {
      window.removeEventListener("lambda:focus", on);
      clearTimeout(pulseTimer.current);
    };
  }, []);

  // Columns: priority lanes (a piece's stories have priorities only; pieces replaced slices).
  const cols: Col[] = PRIORITIES.map((p) => ({
    id: p,
    title: p,
    match: (s: Story) => s.priority === p,
    drop: { priority: p },
    seed: { priority: p },
  }));

  // a tile dragged onto a piece card in the rail moves there (with its runs)
  const overPiece = useRef<string | null>(null);
  const dragMove = (p: Pt) => {
    setHover(colAt(p));
    const pc = pieceAt(p.x - window.scrollX, p.y - window.scrollY);
    const next = pc && pc !== feature.pieceId ? pc : null;
    if (next !== overPiece.current) hoverPiece((overPiece.current = next));
  };
  const moveStory = async (story: Story, toPieceId: string) => {
    setOpen(null);
    setErr(null);
    const storyId = realOf(story.id);
    onChange({ ...feature, stories: feature.stories.filter((s) => s.id !== story.id) }); // optimistic
    try {
      onChange((await pieceAction(fid, { action: "move_story", storyId, toPieceId }, feature.pieceId)).feature);
    } catch (e) {
      setErr((e as Error).message);
      storiesApi.get(fid, feature.pieceId).then(onChange, () => {});
    }
  };
  const otherPieces = sortPieces(feature.pieces).filter((p) => p.id !== feature.pieceId);

  const drop = (story: Story, p: Pt) => {
    setHover(null);
    const pc = overPiece.current;
    if (pc) hoverPiece((overPiece.current = null));
    if (pc) return void moveStory(story, pc);
    const c = cols.find((x) => x.id === colAt(p));
    if (!c || c.match(story)) return;
    op({ op: "update_story", storyId: story.id, ...c.drop });
  };

  const opened = stories.find((s) => s.id === open);
  const showBoard = stories.length > 0 || compose !== null;

  return (
    <MotionConfig reducedMotion="user">
      <div className="space-y-6">
        <AnimatePresence>
          {err && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex items-center justify-between rounded-xl border border-bad/30 bg-bad/5 px-4 py-2 text-sm text-bad"
            >
              <span className="truncate">{err}</span>
              <button onClick={() => setErr(null)} className="ml-3 text-xs" aria-label="dismiss">
                ✕
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {busy === "generate" || (jobBusy && !stories.length) ? (
          <Writing startedAt={reading ? factsJob?.startedAt : jobBusy ? storiesJob?.startedAt : undefined} label={reading ? "reading the code" : undefined} />
        ) : !showBoard ? (
          <EmptyState onGenerate={() => run("generate")} onWrite={() => setCompose("must")} />
        ) : (
          <LayoutGroup>
            <div className="flex items-center justify-end gap-2">
              {/* old tiles stay while the job rewrites them (facts → stories → check) */}
              {jobBusy && <span className="mr-auto font-mono text-[11px] text-grey">{reading ? "reading the code…" : "rewriting…"}</span>}
              <button className="btn btn-ghost" onClick={() => run("generate")} disabled={!!busy || jobBusy}>
                regenerate
              </button>
            </div>

            {/* board scrolls sideways inside itself (snap per column) — never widens the page.
                xl: columns narrow to 210px so five slices fit; past that a fade + "→ n more" says there's more */}
            <SideScroll
              count={cols.length}
              className="-mx-4 grid min-w-0 snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 pb-2 [--col-min:270px] md:mx-0 md:snap-none md:px-0 xl:[--col-min:210px]"
              style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(min(var(--col-min), 82vw), 1fr))` }}
            >
              <AnimatePresence initial={false} mode="popLayout">
                {cols.map((c) => {
                  const items = stories.filter(c.match);
                  return (
                    <motion.div
                      key={c.id}
                      layout
                      data-col={c.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={tileSpring}
                      className={clsx(
                        "relative flex min-h-[220px] min-w-0 snap-start flex-col rounded-[22px] border p-3 transition-colors duration-150",
                        hover === c.id ? "border-ink/40 bg-lilac-soft/60" : "border-transparent bg-paper-2/70",
                        pulse === c.id && "ring-2 ring-lilac",
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-2 px-1 pb-3 pt-1">
                        {c.n && <span className="display text-2xl">{c.n}</span>}
                        <span className="truncate text-sm font-semibold">{c.title}</span>
                        <Meter p={c.id as Priority} />
                        <span className="ml-auto font-mono text-[11px] text-grey">{items.length}</span>
                      </div>
                      <div className="flex flex-1 flex-col gap-3">
                        <AnimatePresence initial={false} mode="popLayout">
                          {items.map((s) => (
                            <StoryTile
                              key={keyOf(s.id)}
                              layoutKey={keyOf(s.id)}
                              story={s}
                              live={live.get(s.id) ?? "untested"}
                              pulse={pulse === s.id || pulse === keyOf(s.id)}
                              onOpen={() => setOpen(s.id)}
                              onPriority={(priority) => priority !== s.priority && op({ op: "update_story", storyId: s.id, priority })}
                              onDragMove={dragMove}
                              onDrop={(p) => drop(s, p)}
                            />
                          ))}
                        </AnimatePresence>
                        {!items.length && compose !== c.id && (
                          <div className="grid flex-1 place-items-center py-6 font-mono text-[11px] text-grey/70">drop stories here</div>
                        )}
                      </div>
                      <QuickAdd
                        open={compose === c.id}
                        onOpen={() => setCompose(c.id)}
                        onClose={() => setCompose((x) => (x === c.id ? null : x))}
                        defaultRole={role}
                        defaultPriority={c.seed.priority}
                        onAdd={(s) => op({ op: "add_story", ...s })}
                      />
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </SideScroll>

            <AnimatePresence>
              {opened && (
                <StoryDetail
                  key={keyOf(opened.id)}
                  layoutKey={keyOf(opened.id)}
                  keyOf={keyOf}
                  story={opened}
                  hidden={hidden}
                  run={lastRun(feature, opened.id)}
                  live={live.get(opened.id) ?? "untested"}
                  starting={starting === opened.id}
                  onOp={op}
                  pieces={otherPieces}
                  onMove={(pid) => void moveStory(opened, pid)}
                  onDelete={() => removeStory(opened)}
                  onDeleteCriterion={(a) =>
                    ops.removeLater(
                      `criterion · ${(a.then || a.when).split(" ").slice(0, 4).join(" ")}`,
                      [{ op: "remove_criterion", storyId: opened.id, criterionId: a.id }],
                      [`${opened.id}/${a.id}`],
                    )
                  }
                  onRun={() => verify(opened)}
                  onOpenRun={(runId) => {
                    setOpen(null);
                    focusTab({ tab: "verify", ref: runId });
                  }}
                  onClose={() => setOpen(null)}
                />
              )}
            </AnimatePresence>
          </LayoutGroup>
        )}

        <UndoToast undo={ops.undo} onUndo={ops.restore} onDismiss={ops.dismissUndo} />
      </div>
    </MotionConfig>
  );
}

function UndoToast({
  undo,
  onUndo,
  onDismiss,
}: {
  undo: ReturnType<typeof useStoryOps>["undo"];
  onUndo: (key: string) => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(onDismiss, Math.max(0, undo.until - Date.now()));
    return () => clearTimeout(t);
  }, [undo, onDismiss]);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4">
      <AnimatePresence>
        {undo && (
          <motion.div
            key={undo.key}
            role="status"
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }}
            transition={{ type: "spring", duration: 0.35, bounce: 0.15 }}
            className="pointer-events-auto relative flex items-center gap-3 overflow-hidden rounded-full bg-ink py-2 pl-4 pr-2 text-[13px] text-paper shadow-[0_18px_40px_-16px_rgba(24,24,24,.6)]"
          >
            <span className="font-mono text-[11px] text-paper/60">−</span>
            <span className="max-w-[46vw] truncate">{undo.label}</span>
            <button
              onClick={() => onUndo(undo.key)}
              className="rounded-full bg-paper/10 px-3 py-1 text-xs font-semibold transition-[background-color,transform] duration-150 hover:bg-paper/20 active:scale-[0.97]"
            >
              undo
            </button>
            {/* 5s countdown hairline */}
            <motion.span
              className="absolute bottom-0 left-0 h-[2px] w-full origin-left bg-lilac"
              initial={{ scaleX: 1 }}
              animate={{ scaleX: 0 }}
              transition={{ duration: UNDO_MS / 1000, ease: "linear" }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function EmptyState({ onGenerate, onWrite }: { onGenerate: () => void; onWrite: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="card relative flex min-h-[340px] items-center overflow-hidden p-10"
    >
      <div className="relative z-10 max-w-md">
        <div className="eyebrow mb-3">user stories</div>
        <h2 className="display text-5xl">
          who wants <span className="italic">what</span>, and why?
        </h2>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {["role", "want", "why", "browser test"].map((t) => (
            <span key={t} className="chip font-mono !text-[11px] !font-normal text-ink-2">
              {t}
            </span>
          ))}
        </div>
        <div className="mt-6 flex gap-2">
          <button className="btn btn-primary" onClick={onGenerate}>
            generate stories
          </button>
          <button className="btn btn-ghost" onClick={onWrite}>
            write one
          </button>
        </div>
      </div>
      <Image
        src="/art/sage-compass.webp"
        alt=""
        width={900}
        height={1128}
        className="pointer-events-none absolute -bottom-4 right-2 hidden h-[340px] w-auto object-contain md:block"
      />
    </motion.div>
  );
}

function Writing({ startedAt, label = "writing stories" }: { startedAt?: string; label?: string }) {
  return (
    <div className="flex justify-center py-6">
      <Scribe label={label} startedAt={startedAt} labelAt="top" />
    </div>
  );
}

// Horizontal scroller with an edge fade and a "→ n more" chip while columns are hidden to the right.
function SideScroll({ count, className, style, children }: { count: number; className: string; style: React.CSSProperties; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const over = el.scrollWidth - el.clientWidth - el.scrollLeft;
      const col = el.scrollWidth / Math.max(1, count);
      setHidden(over > 8 ? Math.max(1, Math.round(over / col)) : 0);
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [count]);
  return (
    <div className="relative">
      <div ref={ref} className={className} style={style}>
        {children}
      </div>
      <div
        aria-hidden
        className={clsx(
          "pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-paper to-transparent transition-opacity duration-200 max-md:hidden",
          hidden ? "opacity-100" : "opacity-0",
        )}
      />
      <AnimatePresence>
        {hidden > 0 && (
          <motion.button
            type="button"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.12 } }}
            transition={{ type: "spring", stiffness: 500, damping: 34 }}
            onClick={() => ref.current?.scrollBy({ left: ref.current.clientWidth * 0.8, behavior: "smooth" })}
            className="absolute right-1 top-3 rounded-full border border-line-2 bg-card px-2.5 py-1 font-mono text-[11px] text-ink-2 shadow-[0_8px_20px_-14px_rgba(24,24,24,.5)] transition-transform active:scale-[0.97] max-md:hidden"
          >
            → {hidden} more
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
