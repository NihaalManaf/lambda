"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { nanoid } from "nanoid";
import { featureMode, type Annotation, type AnnotationKind, type Box, type FeatureMode, type FeatureView } from "@/lib/types";
import Painter from "@/components/Painter";
import { appDown, captureMockup, deleteMockup, loadSettings, resketch, saveAnnotations, shotUrl, startSketchJob, type SettingsLite, type SketchMockup } from "./api";
import AnnotationList from "./AnnotationList";
import CaptureBar, { type CaptureInput } from "./CaptureBar";
import KindIcon from "./KindIcon";
import { KINDS, kindMeta } from "./marks";
import { DEFAULT_VIEWPORT, foldOf, viewportOf, VIEWPORTS } from "@/lib/viewports";
import SketchCanvas from "./SketchCanvas";
import { useStack } from "@/components/stack/api";

// UI sketch: marker over a real screenshot of the running frontend. Scope, not a render.

type Job = { kind: "capture" | "sketch"; label: string; withSketch: boolean; t0: number };

const PHASES = {
  capture: ["launching browser", "loading page", "measuring boxes", "sketching with marker"],
  sketch: ["reading the screenshot", "picking spots", "sketching with marker"],
};

function phaseOf(job: Job, sec: number) {
  if (job.kind === "sketch") return PHASES.sketch[Math.min(2, Math.floor(sec / 5))];
  const i = sec < 3 ? 0 : sec < 8 ? 1 : sec < 12 || !job.withSketch ? 2 : 3;
  return PHASES.capture[i];
}

const spring = { type: "spring", stiffness: 420, damping: 36 } as const;

// per-mode copy + palette: understand only explains the existing ui, so it draws notes only
const COPY: Record<FeatureMode, { again: string; start: string; ask: string; running: string; rerun: string; run: string; eyebrow: string }> = {
  build: { again: "auto-sketch again", start: "auto-sketch this piece", ask: "what changes?", running: "sketching…", rerun: "re-sketch", run: "sketch it", eyebrow: "ui sketch" },
  understand: { again: "auto-annotate again", start: "auto-annotate this area", ask: "what to point out?", running: "annotating…", rerun: "re-annotate", run: "annotate", eyebrow: "ui map" },
};
const KINDS_FOR: Record<FeatureMode, typeof KINDS> = { build: KINDS, understand: KINDS.filter((k) => k.kind === "note") };
// event-time stamp for the local job timer (handlers only)
const stamp = () => Date.now();
// "http://localhost:3000/plans?x" with base "http://localhost:3000" → "/plans?x"; other origins → null
const sameOrigin = (target: string, base: string) => {
  try {
    const t = new URL(target), b = new URL(base);
    return t.origin === b.origin ? `${t.pathname}${t.search}${t.hash}` || "/" : null;
  } catch {
    return null;
  }
};

export default function MockupTab({ feature, onChange }: { feature: FeatureView; onChange: (f: FeatureView) => void }) {
  // auto sketches (the background job) first, then manual captures, each newest first as stored
  const mockups = [...feature.mockups.filter((m) => m.auto), ...feature.mockups.filter((m) => !m.auto)] as SketchMockup[];
  const autoJob = feature.jobs?.find((j) => j.kind === "sketch");
  const fmode = featureMode(feature);
  const understand = fmode === "understand"; // marks explain the existing ui
  const copy = COPY[fmode];
  const kinds = KINDS_FOR[fmode];
  const autoBusy = autoJob?.status === "queued" || autoJob?.status === "running";
  // lambda's own copy of the app, when its local stack is up: the one auto-sketch and bare paths already use,
  // so the page field, the down card and manual captures point at it too (not the settings url)
  const { view: stack } = useStack(feature.id);
  const front = stack?.services.find((s) => s.role === "frontend");
  const appUrl = front?.status === "ready" ? front.url : undefined;
  const down = appDown(autoJob);
  const rootRef = useRef<HTMLDivElement>(null);
  const [settings, setSettings] = useState<SettingsLite | null>(null);
  const [activeId, setActiveId] = useState<string | null>(mockups[0]?.id ?? null);
  const [job, setJob] = useState<Job | null>(null);
  const [sec, setSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [mode, setMode] = useState<"select" | "draw">("select");
  const [drawKind, setDrawKind] = useState<AnnotationKind>(understand ? "note" : "insert");
  const [intentDraft, setIntentDraft] = useState<Record<string, string>>({});
  const [save, setSave] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [fit, setFit] = useState<"screen" | "width">("screen");

  const active = mockups.find((m) => m.id === activeId) ?? mockups[0];
  const anns = active?.annotations ?? [];
  const intent = active ? (intentDraft[active.id] ?? active.intent ?? "") : "";

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  useEffect(() => {
    if (!job) return;
    const t = setInterval(() => setSec(Math.floor((Date.now() - job.t0) / 1000)), 500);
    return () => clearInterval(t);
  }, [job]);

  // ---------- debounced annotation saves (optimistic: local state is truth) ----------

  const timers = useRef(new Map<string, { t: ReturnType<typeof setTimeout>; run: () => Promise<void> }>());

  const flush = useCallback(async () => {
    const pending = [...timers.current.values()];
    timers.current.clear();
    pending.forEach((p) => clearTimeout(p.t));
    await Promise.all(pending.map((p) => p.run()));
  }, []);

  useEffect(() => () => void flush(), [flush]);

  const setAnns = (next: Annotation[]) => {
    if (!active) return;
    const mid = active.id;
    onChange({ ...feature, mockups: feature.mockups.map((m) => (m.id === mid ? { ...m, annotations: next } : m)) });
    setSave("saving");
    const prev = timers.current.get(mid);
    if (prev) clearTimeout(prev.t);
    const run = () =>
      saveAnnotations(feature.id, mid, next).then(
        () => setSave("saved"),
        () => setSave("error"),
      );
    timers.current.set(mid, {
      run,
      t: setTimeout(() => {
        timers.current.delete(mid);
        void run();
      }, 450),
    });
  };

  const editAnn = (a: Annotation) => setAnns(anns.map((x) => (x.id === a.id ? a : x)));
  const deleteAnn = (id: string) => {
    setAnns(anns.filter((x) => x.id !== id));
    setSelId(null);
  };
  const createAnn = (kind: AnnotationKind, box: Box) => {
    const a: Annotation = { id: `an_${nanoid(8)}`, kind, box, label: kindMeta(kind).hint };
    if (kind === "move") a.to = { ...box, y: Math.min((active?.height ?? 0) - box.h, box.y + box.h + 60) };
    setAnns([...anns, a]);
    setSelId(a.id);
    setMode("select");
  };

  // ---------- capture / sketch ----------

  const capture = async (c: CaptureInput) => {
    setError(null);
    await flush();
    // the settings origin typed out while lambda's app is up → send the path, so it lands on lambda's app
    const own = appUrl && settings?.frontendUrl ? sameOrigin(c.target, settings.frontendUrl) : null;
    if (own) c = { ...c, target: own };
    const isUrl = /^https?:\/\//i.test(c.target);
    setJob({ kind: "capture", label: c.target.replace(/^https?:\/\//, ""), withSketch: Boolean(c.intent), t0: Date.now() });
    setSec(0);
    try {
      const { feature: f, sketchError } = await captureMockup(feature.id, {
        ...(isUrl ? { url: c.target } : { path: c.target }),
        accountId: c.accountId,
        intent: c.intent || undefined,
        pieceId: feature.pieceId || undefined,
        viewport: c.viewport,
      });
      onChange(f);
      setActiveId(f.mockups[0]?.id ?? null);
      setSelId(null);
      if (sketchError) setError(`captured, but sketch failed: ${sketchError}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setJob(null);
    }
  };

  const runSketch = async () => {
    if (!active || job) return;
    setError(null);
    await flush();
    setJob({ kind: "sketch", label: active.title, withSketch: true, t0: stamp() });
    setSec(0);
    setSelId(null);
    try {
      onChange(await resketch(feature.id, active.id, intent));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setJob(null);
    }
  };

  const remove = async (mid: string) => {
    await flush();
    const prev = feature;
    const rest = feature.mockups.filter((m) => m.id !== mid);
    onChange({ ...feature, mockups: rest });
    if (activeId === mid) setActiveId(rest[0]?.id ?? null);
    deleteMockup(feature.id, mid).catch((e) => {
      onChange(prev);
      setError((e as Error).message);
    });
  };

  // ---------- keyboard ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (rootRef.current?.closest("[inert]")) return; // tab hidden
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "Escape") {
        setSelId(null);
        setMode("select");
      } else if ((e.key === "Backspace" || e.key === "Delete") && selId) {
        e.preventDefault();
        deleteAnn(selId);
      } else if (e.key === "d" && !e.metaKey && !e.ctrlKey) setMode((m) => (m === "draw" ? "select" : "draw"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const capturing = job?.kind === "capture";

  // start / re-run the background sketch job for this piece
  const [starting, setStarting] = useState(false);
  const retryAuto = async () => {
    if (starting) return;
    setError(null);
    setStarting(true);
    try {
      onChange(await startSketchJob(feature.id, feature.pieceId || undefined));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };
  // the auto sketch gave up because the app was down; lambda's app has come up since → try once more on its own
  const retried = useRef(false);
  const downNow = appDown(autoJob);
  useEffect(() => {
    if (!downNow) retried.current = false;
    else if (appUrl && !retried.current) {
      retried.current = true;
      void retryAuto();
    }
    // retryAuto is recreated each render; the guard keeps this to one try per outage
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downNow, appUrl]);


  return (
    <div ref={rootRef} className="flex flex-col gap-6">
      <CaptureBar settings={settings} appUrl={appUrl} busy={Boolean(job)} onCapture={capture} understand={understand} />

      <AnimatePresence initial={false}>
        {down && !autoBusy && (
          <motion.div key="down" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}>
            <AppDownCard url={appUrl ?? autoJob?.error?.replace(/^app not running at /, "") ?? settings?.frontendUrl ?? ""} reason={autoJob?.error} onRetry={retryAuto} />
          </motion.div>
        )}
        {autoJob?.status === "error" && !down && !autoBusy && (
          <motion.button
            key="autoerr"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={retryAuto}
            title={autoJob.error}
            className="chip self-start !border-bad/40 text-bad"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-bad" /> auto sketch failed · retry
          </motion.button>
        )}
        {autoJob?.status === "done" && !autoBusy && (
          <motion.div key="note" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 self-start">
            {autoJob.note && <AutoNote note={autoJob.note} />}
            <button onClick={retryAuto} disabled={starting} className="chip hover:border-ink disabled:opacity-50">
              {copy.again}
            </button>
          </motion.div>
        )}
        {!autoJob && (
          <motion.button
            key="start"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={retryAuto}
            disabled={starting}
            className="chip self-start hover:border-ink disabled:opacity-50"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-lilac" /> {copy.start}
          </motion.button>
        )}
      </AnimatePresence>

      {autoBusy && (
        <div className={mockups.length ? "flex items-center gap-3" : "flex justify-center py-6"}>
          <Painter
            label={autoJob?.status === "queued" ? "waiting for stories" : "sketching your app"}
            startedAt={autoJob?.startedAt}
            size={mockups.length ? "xs" : "md"}
            labelAt={mockups.length ? "bottom" : "top"}
          />
        </div>
      )}

      <AnimatePresence>
        {error && (
          <motion.button
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            onClick={() => setError(null)}
            className="chip self-start !border-bad/40 !bg-bad/5 !text-bad"
          >
            {error} <span className="opacity-50">×</span>
          </motion.button>
        )}
      </AnimatePresence>

      {/* strip of sketches */}
      {(mockups.length > 0 || capturing) && (
        <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
          <AnimatePresence initial={false}>
            {capturing && (
              <motion.div
                key="pending"
                layout
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={spring}
                className="w-44 shrink-0"
              >
                <div className="shimmer aspect-[4/3] rounded-xl border border-line" />
                <div className="mt-1.5 truncate font-mono text-[11px] text-grey">{job.label}</div>
              </motion.div>
            )}
            {mockups.map((m) => (
              <motion.div
                key={m.id}
                layout
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={spring}
                className="group relative w-44 shrink-0"
              >
                <button onClick={() => (setActiveId(m.id), setSelId(null))} className="block w-full text-left">
                  <div className="relative aspect-[4/3] overflow-hidden rounded-xl border border-line bg-paper-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={shotUrl(m.thumb ?? m.shot)} alt="" loading="lazy" className="h-full w-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.03]" />
                    {m.auto && <span className="chip absolute left-1.5 top-1.5 !px-1.5 !py-0 font-mono !text-[10px] text-grey">auto</span>}
                    {m.annotations.length > 0 && (
                      <span className="chip absolute bottom-1.5 left-1.5 !py-0 font-hand !text-[13px] !text-marker">
                        {m.annotations.length} marks
                      </span>
                    )}
                    {active?.id === m.id && (
                      <motion.span layoutId="sketch-active" transition={spring} className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-ink ring-inset" />
                    )}
                  </div>
                  <div className="mt-1.5 truncate font-mono text-[11px] text-grey">
                    {pathOf(m.url)}
                    {m.width !== viewportOf(DEFAULT_VIEWPORT).width && <span className="opacity-60"> · {VIEWPORTS.find((v) => v.width === m.width)?.name ?? `${m.width}px`}</span>}
                  </div>
                </button>
                <button
                  onClick={() => remove(m.id)}
                  aria-label="delete sketch"
                  className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-ink/80 text-[13px] text-paper opacity-0 transition-opacity group-hover:opacity-100"
                >
                  ×
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {capturing && !active && <Pending text={phaseOf(job, sec)} />}
      {!active && !job && !autoBusy && !down && <Empty kinds={kinds} eyebrow={copy.eyebrow} />}

      {active && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex min-w-0 flex-col gap-3">
            {/* toolbar: mode + legend (legend doubles as the draw palette) */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-full border border-line-2 bg-card p-0.5">
                {(["select", "draw"] as const).map((md) => (
                  <button key={md} onClick={() => setMode(md)} className={`relative rounded-full px-3 py-1 text-[13px] font-semibold ${mode === md ? "text-paper" : "text-ink-2"}`}>
                    {mode === md && <motion.span layoutId="sketch-mode" transition={spring} className="absolute inset-0 rounded-full bg-ink" />}
                    <span className="relative">{md}</span>
                  </button>
                ))}
              </div>
              <span className="mx-1 h-4 w-px bg-line-2" />
              {kinds.map((k) => {
                const on = mode === "draw" && drawKind === k.kind;
                return (
                  <button
                    key={k.kind}
                    onClick={() => (setDrawKind(k.kind), setMode("draw"))}
                    className={`chip transition-all ${on ? "!border-ink shadow-[0_2px_0_0_var(--ink)]" : "hover:border-ink"}`}
                    title={`draw: ${k.name}`}
                  >
                    <KindIcon kind={k.kind} size={12} />
                    {k.name}
                  </button>
                );
              })}
              <span className="ml-auto font-mono text-[11px] text-grey">
                {mode === "draw" ? "drag a box · esc" : save === "saving" ? "saving…" : save === "error" ? "save failed" : save === "saved" ? "saved" : "d = draw"}
              </span>
              <div className="flex rounded-full border border-line-2 bg-card p-0.5" title={`captured at ${active.width}×${foldOf(active)}`}>
                {(["screen", "width"] as const).map((f) => (
                  <button key={f} onClick={() => setFit(f)} className={`relative rounded-full px-2.5 py-0.5 font-mono text-[11px] ${fit === f ? "text-paper" : "text-grey"}`}>
                    {fit === f && <motion.span layoutId="sketch-fit" transition={spring} className="absolute inset-0 rounded-full bg-ink" />}
                    <span className="relative">fit {f}</span>
                  </button>
                ))}
              </div>
            </div>

            <div
              className="relative mx-auto max-h-[78vh] w-full overflow-y-auto overscroll-contain rounded-2xl border border-line bg-card shadow-[0_20px_60px_-30px_rgba(24,24,24,0.35)]"
              // never past capture size; "screen": the first screen (one viewport tall) fits the frame
              style={{
                maxWidth:
                  fit === "screen"
                    ? `min(100%, ${active.width}px, calc(72vh * ${(active.width / foldOf(active)).toFixed(4)}))`
                    : `min(100%, ${active.width}px)`,
              }}
            >
              <SketchCanvas
                key={active.id}
                mockup={active}
                annotations={anns}
                selectedId={selId}
                hoverId={hoverId}
                mode={mode}
                drawKind={drawKind}
                busy={job?.kind === "sketch"}
                onSelect={setSelId}
                onEdit={editAnn}
                onCreate={createAnn}
              />
              {job?.kind === "sketch" && (
                <div className="pointer-events-none sticky bottom-4 flex justify-center">
                  <span className="chip !px-3 !py-1 font-hand !text-[16px] shadow-lg">{phaseOf(job, sec)}…</span>
                </div>
              )}
            </div>
          </div>

          <aside className="flex flex-col gap-5 lg:sticky lg:top-20 lg:self-start">
            <div>
              <div className="eyebrow">page</div>
              <a href={active.url} target="_blank" rel="noreferrer" className="mt-1 block truncate font-serif text-xl hover:underline">
                {active.title}
              </a>
              <div className="truncate font-mono text-[11px] text-grey">{pathOf(active.url)}</div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="eyebrow">{copy.ask}</div>
              <textarea
                className="input max-h-64 min-h-[5.5rem] resize-none font-hand !text-[16px] leading-snug [field-sizing:content]"
                rows={3}
                value={intent}
                placeholder="tell the marker…"
                onChange={(e) => setIntentDraft((d) => ({ ...d, [active.id]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runSketch();
                }}
              />
              <button className="btn btn-lilac self-start" disabled={Boolean(job) || !intent.trim()} onClick={() => void runSketch()}>
                {job?.kind === "sketch" ? copy.running : anns.length ? copy.rerun : copy.run}
              </button>
            </div>

            <div className="flex flex-col gap-2">
              <div className="eyebrow">marks · {anns.length}</div>
              {job?.kind === "sketch" ? (
                <div className="flex flex-col gap-1.5">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="shimmer h-10 rounded-xl" />
                  ))}
                </div>
              ) : (
                <AnnotationList annotations={anns} selectedId={selId} onSelect={setSelId} onHover={setHoverId} onEdit={editAnn} onDelete={deleteAnn} kinds={kinds} />
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function pathOf(url: string) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

function Pending({ text }: { text: string }) {
  return (
    <div className="card relative grid aspect-[16/9] place-items-center overflow-hidden">
      <div className="shimmer absolute inset-0 opacity-60" />
      <motion.span key={text} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="relative font-hand text-2xl">
        {text}…
      </motion.span>
    </div>
  );
}

// the job's caveat line; a pointer at settings becomes a link there
function AutoNote({ note }: { note: string }) {
  const i = note.indexOf("in settings");
  if (i < 0) return <span className="font-mono text-[11px] text-grey">{note}</span>;
  return (
    <span className="font-mono text-[11px] text-grey">
      {note.slice(0, i)}
      <a href="/settings" className="text-ink underline decoration-line-2 underline-offset-2 hover:decoration-ink">
        in settings
      </a>
      {note.slice(i + "in settings".length)}
    </span>
  );
}

function AppDownCard({ url, reason, onRetry }: { url: string; reason?: string; onRetry: () => void }) {
  const other = reason?.match(/ is serving (.+), not (.+)$/);
  return (
    <div className="card flex flex-wrap items-center gap-4 px-6 py-5">
      <div className="min-w-0 flex-1">
        <div className="eyebrow">auto sketch · waiting</div>
        {other ? (
          <>
            <p className="mt-1 text-[15px] text-ink-2">
              <span className="font-mono text-[13px] text-ink">{url.replace(/^https?:\/\//, "")}</span> is running{" "}
              <span className="font-mono text-[13px] text-ink">{other[1]}</span>, not {other[2]}
            </p>
            <p className="mt-0.5 text-[13px] text-grey">stop that server or change app url in settings, then retry.</p>
          </>
        ) : (
          <>
            <p className="mt-1 text-[15px] text-ink-2">
              your app isn&apos;t running at <span className="font-mono text-[13px] text-ink">{url.replace(/^https?:\/\//, "")}</span>
            </p>
            <p className="mt-0.5 text-[13px] text-grey">start it, then retry. manual capture still works.</p>
          </>
        )}
      </div>
      <button className="btn btn-ghost" onClick={onRetry}>
        retry
      </button>
    </div>
  );
}

function Empty({ kinds, eyebrow }: { kinds: typeof KINDS; eyebrow: string }) {
  return (
    <div className="card relative flex min-h-[280px] items-center overflow-hidden px-8 py-10">
      <div className="relative z-10 max-w-sm">
        <div className="eyebrow">{eyebrow}</div>
        <h3 className="display mt-2 text-4xl">
          mark up the <em>real</em> thing.
        </h3>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {kinds.map((k) => (
            <span key={k.kind} className="chip">
              <KindIcon kind={k.kind} size={12} />
              {k.name}
            </span>
          ))}
        </div>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/art/muse-orb.webp" alt="" className="pointer-events-none absolute -bottom-6 right-4 h-[115%] w-auto object-contain opacity-90" />
    </div>
  );
}
