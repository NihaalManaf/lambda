"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { nanoid } from "nanoid";
import type { Annotation, AnnotationKind, Box, Feature } from "@/lib/types";
import { captureMockup, deleteMockup, loadSettings, resketch, saveAnnotations, shotUrl, type SettingsLite, type SketchMockup } from "./api";
import AnnotationList from "./AnnotationList";
import CaptureBar, { type CaptureInput } from "./CaptureBar";
import KindIcon from "./KindIcon";
import { KINDS, kindMeta } from "./marks";
import SketchCanvas from "./SketchCanvas";

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

export default function MockupTab({ feature, onChange }: { feature: Feature; onChange: (f: Feature) => void }) {
  const mockups = feature.mockups as SketchMockup[];
  const rootRef = useRef<HTMLDivElement>(null);
  const [settings, setSettings] = useState<SettingsLite | null>(null);
  const [activeId, setActiveId] = useState<string | null>(mockups[0]?.id ?? null);
  const [job, setJob] = useState<Job | null>(null);
  const [sec, setSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [mode, setMode] = useState<"select" | "draw">("select");
  const [drawKind, setDrawKind] = useState<AnnotationKind>("insert");
  const [intentDraft, setIntentDraft] = useState<Record<string, string>>({});
  const [save, setSave] = useState<"idle" | "saving" | "saved" | "error">("idle");

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
    const isUrl = /^https?:\/\//i.test(c.target);
    setJob({ kind: "capture", label: c.target.replace(/^https?:\/\//, ""), withSketch: Boolean(c.intent), t0: Date.now() });
    setSec(0);
    try {
      const { feature: f, sketchError } = await captureMockup(feature.id, {
        ...(isUrl ? { url: c.target } : { path: c.target }),
        accountId: c.accountId,
        intent: c.intent || undefined,
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
    setJob({ kind: "sketch", label: active.title, withSketch: true, t0: Date.now() });
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

  return (
    <div ref={rootRef} className="flex flex-col gap-6">
      <CaptureBar settings={settings} busy={Boolean(job)} onCapture={capture} />

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
                    {m.annotations.length > 0 && (
                      <span className="chip absolute bottom-1.5 left-1.5 !py-0 font-hand !text-[13px] !text-marker">
                        {m.annotations.length} marks
                      </span>
                    )}
                    {active?.id === m.id && (
                      <motion.span layoutId="sketch-active" transition={spring} className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-ink ring-inset" />
                    )}
                  </div>
                  <div className="mt-1.5 truncate font-mono text-[11px] text-grey">{pathOf(m.url)}</div>
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
      {!active && !job && <Empty />}

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
              {KINDS.map((k) => {
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
            </div>

            <div className="relative max-h-[78vh] overflow-y-auto overscroll-contain rounded-2xl border border-line bg-card shadow-[0_20px_60px_-30px_rgba(24,24,24,0.35)]">
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
              <div className="eyebrow">what changes?</div>
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
              <button className="btn btn-lilac self-start" disabled={Boolean(job) || !intent.trim()} onClick={runSketch}>
                {job?.kind === "sketch" ? "sketching…" : anns.length ? "re-sketch" : "sketch it"}
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
                <AnnotationList annotations={anns} selectedId={selId} onSelect={setSelId} onHover={setHoverId} onEdit={editAnn} onDelete={deleteAnn} />
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

function Empty() {
  return (
    <div className="card relative flex min-h-[280px] items-center overflow-hidden px-8 py-10">
      <div className="relative z-10 max-w-sm">
        <div className="eyebrow">ui sketch</div>
        <h3 className="display mt-2 text-4xl">
          mark up the <em>real</em> thing.
        </h3>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {KINDS.map((k) => (
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
