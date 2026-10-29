"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import Sculptor from "@/components/Sculptor";
import { cmdText, stackApi, wiringOf, useStack, type StackPlan, type StackService, type StackView } from "@/components/stack/api";
import { Dot, ROLES, RoleIcon } from "@/components/stack/bits";
import PlanView from "@/components/stack/PlanView";

const spring = { type: "spring", stiffness: 420, damping: 34 } as const;

// settings → 06 · local stack: the plan lambda uses to boot its own copy of your app on free ports. Edits autosave
// (and need a fresh approval); raw JSON for everything the rows don't cover.
export default function StackSettings() {
  const { view, act, error, missing } = useStack();
  const [draft, setDraft] = useState<StackPlan | null>(null);
  const [raw, setRaw] = useState(false);
  const [gen, setGen] = useState(0); // remounts the rows (their local command text) when the plan comes from elsewhere
  const [rawText, setRawText] = useState("");
  const [rawErr, setRawErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dirty = useRef(false);

  // adopt the server plan unless the person is mid-edit
  useEffect(() => {
    if (!view || dirty.current) return;
    setDraft(view.plan);
    setGen((g) => g + 1);
    setRawText(view.plan ? JSON.stringify(view.plan, null, 2) : "");
  }, [view]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const change = (next: StackPlan) => {
    dirty.current = true;
    setDraft(next);
    if (!raw) setRawText(JSON.stringify(next, null, 2));
    setSaved("saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        await stackApi.savePlan(next);
        dirty.current = false;
        setSaveErr(null);
        setSaved("saved");
        setTimeout(() => setSaved((s) => (s === "saved" ? "idle" : s)), 1400);
        void act(async () => undefined); // re-read: an edit withdraws approval
      } catch (e) {
        // stays dirty: a half-typed plan doesn't validate yet; keep the person's text
        setSaveErr((e as Error).message);
        setSaved("error");
      }
    }, 800);
  };

  const setSvc = (i: number, patch: Partial<StackService>) =>
    draft && change({ ...draft, services: draft.services.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  const onRaw = (text: string) => {
    setRawText(text);
    try {
      const p = JSON.parse(text) as StackPlan;
      if (!Array.isArray(p.services)) throw new Error("services must be a list");
      setRawErr(null);
      change({ services: p.services, setup: p.setup ?? [], env: p.env ?? {}, envFiles: p.envFiles ?? [], notes: p.notes ?? [] });
    } catch (e) {
      setRawErr((e as Error).message);
    }
  };

  const anyUp = !!view?.services.some((s) => s.status === "ready" || s.status === "starting");

  return (
    <section id="stack" className="mt-12 grid scroll-mt-24 gap-6 border-t border-line pt-8 md:grid-cols-[220px_1fr]">
      <div>
        <div className="eyebrow">06 · local stack</div>
        <h2 className="display mt-2 text-3xl">
          your app, <span className="italic">hosted</span>
        </h2>
        <div className="mt-3 text-[13px] text-grey">lambda&apos;s own copy, on free ports — your servers stay untouched</div>
      </div>

      <div>
        {!view ? (
          <div className="h-24 animate-pulse rounded-[18px] bg-paper-2" />
        ) : missing || !view.repo ? (
          <p className="text-[13px] text-grey">set a repo path in 02 first.</p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <ApproveChip view={view} />
              {view.services.length > 0 && (
                <span className="chip gap-1.5 font-mono text-[11px] text-ink-2">
                  {view.services.map((s) => (
                    <Dot key={s.name} status={s.status} />
                  ))}
                  {view.services.filter((s) => s.status === "ready").length}/{view.services.length} up
                </span>
              )}
              <AnimatePresence>
                {saved !== "idle" && (
                  <motion.span
                    initial={{ opacity: 0, y: 2 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className={clsx("font-mono text-[11px]", saved === "error" ? "text-bad" : saved === "saved" ? "text-ok" : "text-grey")}
                  >
                    {saved === "saving" ? "saving" : saved === "saved" ? "saved ✓" : "not saved"}
                  </motion.span>
                )}
              </AnimatePresence>
              <span className="flex-1" />
              {view.plan && !view.approved && (
                <button className="btn btn-primary !px-3 !py-1 text-[12px]" disabled={saved === "saving" || saved === "error"} onClick={() => act(() => stackApi.approve(view.planHash))}>
                  approve
                </button>
              )}
              {anyUp && (
                <button className="btn btn-ghost !px-3 !py-1 text-[12px]" disabled={view.foreign} onClick={() => act(() => stackApi.stop())}>
                  stop all
                </button>
              )}
              <button
                className="btn btn-ghost !px-3 !py-1 text-[12px]"
                disabled={view.planning}
                onClick={() => {
                  dirty.current = false;
                  setSaveErr(null);
                  void act(stackApi.plan);
                }}
              >
                {view.plan ? "re-plan" : "map my stack"}
              </button>
            </div>

            {(saveErr || error) && <p className="mb-2 font-mono text-[11px] text-bad">{saveErr ?? error}</p>}
            {view.plan && !view.approved && !view.planning && (
              <div className="card mb-4 px-5 py-4" data-testid="stack-review">
                <div className="eyebrow mb-3">what approve runs — exactly</div>
                <PlanView plan={view.plan} warnings={view.warnings} localRefs={view.localRefs} full />
              </div>
            )}
            {view.planning ? (
              <div className="card flex items-center gap-4 px-5 py-4">
                <Sculptor size="xs" />
                <div>
                  <p className="display text-xl">
                    mapping your <span className="italic">stack</span>…
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-grey">reading AGENTS.md, package.json, procfiles</p>
                </div>
              </div>
            ) : !draft ? (
              <p className="text-[13px] text-grey">{view.record?.planError ? <span className="text-bad">{view.record.planError}</span> : "no plan yet."}</p>
            ) : (
              <>
                <div className="mb-2 flex items-center gap-1 text-[12px]">
                  <Toggle on={!raw} onClick={() => {
                      setRaw(false);
                      setGen((g) => g + 1);
                    }}>
                    rows
                  </Toggle>
                  <Toggle on={raw} onClick={() => setRaw(true)}>
                    json
                  </Toggle>
                </div>

                {raw ? (
                  <>
                    <textarea
                      className="input min-h-[320px] resize-y font-mono text-[12px] leading-relaxed"
                      spellCheck={false}
                      value={rawText}
                      onChange={(e) => onRaw(e.target.value)}
                    />
                    {rawErr && <p className="mt-1.5 font-mono text-[11px] text-bad">{rawErr}</p>}
                  </>
                ) : (
                  <div className="space-y-2.5">
                    <AnimatePresence initial={false}>
                      {draft.services.map((s, i) => (
                        <motion.div
                          key={`${gen}:${i}`}
                          layout
                          initial={{ opacity: 0, scale: 0.98 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.98 }}
                          transition={spring}
                        >
                          <ServiceEditor
                            s={s}
                            onPatch={(p) => setSvc(i, p)}
                            onRemove={() => change({ ...draft, services: draft.services.filter((_, j) => j !== i) })}
                          />
                        </motion.div>
                      ))}
                    </AnimatePresence>
                    <button
                      onClick={() =>
                        change({ ...draft, services: [...draft.services, { name: "", role: "other", cwd: ".", cmd: [""] }] })
                      }
                      className="w-full rounded-[14px] border border-dashed border-line-2 py-2.5 text-[13px] text-grey transition-colors hover:border-ink hover:text-ink"
                    >
                      + add service
                    </button>
                    <Summary plan={draft} />
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ApproveChip({ view }: { view: StackView }) {
  if (!view.plan) return <span className="chip font-mono text-[11px] text-grey">no plan</span>;
  return view.approved ? (
    <span className="chip font-mono text-[11px] text-ok">
      <span className="h-1.5 w-1.5 rounded-full bg-ok" />
      approved
    </span>
  ) : (
    <span className="chip border-ink font-mono text-[11px] text-ink">
      <span className="h-1.5 w-1.5 rounded-full bg-lilac" />
      needs ok
    </span>
  );
}

function ServiceEditor({ s, onPatch, onRemove }: { s: StackService; onPatch: (p: Partial<StackService>) => void; onRemove: () => void }) {
  // the command is edited as one line; it keeps its own text so quotes / spaces survive while typing
  const [cmd, setCmd] = useState(() => cmdText(s.cmd));
  return (
    <div className="card space-y-2 p-3.5">
      <div className="flex items-center gap-2">
        <RoleIcon role={s.role} className="text-grey" />
        <input
          className="display min-w-0 flex-1 bg-transparent text-xl outline-none placeholder:text-line-2"
          placeholder="frontend, api…"
          value={s.name}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <select
          value={s.role}
          onChange={(e) => onPatch({ role: e.target.value as StackService["role"] })}
          aria-label="role"
          className="rounded-full border border-line-2 bg-card px-2.5 py-1 font-mono text-[11px] text-ink-2 outline-none focus:border-ink"
        >
          {ROLES.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-grey">
          <input type="checkbox" className="accent-[var(--ink)]" checked={!!s.optional} onChange={(e) => onPatch({ optional: e.target.checked || undefined })} />
          optional
        </label>
        <button onClick={onRemove} aria-label="remove service" className="px-1 text-grey transition-colors hover:text-bad">
          ×
        </button>
      </div>
      <input
        className="input font-mono !py-2 text-[12.5px]"
        placeholder="command · npx next dev -H 127.0.0.1 -p ${port}"
        spellCheck={false}
        value={cmd}
        onChange={(e) => {
          setCmd(e.target.value);
          onPatch(parseCmd(e.target.value));
        }}
      />
      <div className="grid grid-cols-2 gap-2">
        <input className="input font-mono !py-2 text-[12px]" placeholder="cwd · frontend" value={s.cwd} onChange={(e) => onPatch({ cwd: e.target.value })} />
        <input
          className="input font-mono !py-2 text-[12px]"
          placeholder="ready path · /health"
          value={s.ready?.path ?? ""}
          onChange={(e) => {
            const { path: _p, ...rest } = s.ready ?? {};
            void _p;
            const ready = e.target.value ? { ...rest, path: e.target.value } : rest;
            onPatch({ ready: Object.keys(ready).length ? ready : undefined });
          }}
        />
      </div>
    </div>
  );
}

// one command line -> argv (quotes respected), or a shell line when it needs one (&&, |, source, redirects…)
function parseCmd(text: string): Pick<StackService, "cmd" | "shell"> {
  if (/&&|\|\||[|;<>`]|\$\(|^\s*(source|\.|export|cd)\s/.test(text)) return { cmd: text, shell: true };
  const argv: string[] = [];
  let cur = "";
  let q: string | null = null;
  let any = false;
  for (const ch of text) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      q = ch;
      any = true;
    } else if (/\s/.test(ch)) {
      if (cur || any) argv.push(cur);
      cur = "";
      any = false;
    } else cur += ch;
  }
  if (cur || any) argv.push(cur);
  return { cmd: argv.length ? argv : [""], shell: undefined };
}

// the bits the rows don't edit, at a glance (edit them in json)
function Summary({ plan }: { plan: StackPlan }) {
  const wires = wiringOf(plan);
  const bits = [
    plan.setup.length ? `${plan.setup.length} setup step${plan.setup.length > 1 ? "s" : ""}` : null,
    wires.length ? wires.map((w) => `${w.from} → ${w.to}`).join(" · ") : null,
    plan.envFiles.length ? `env: ${plan.envFiles.join(", ")}` : null,
  ].filter(Boolean);
  if (!bits.length) return null;
  return <p className="pt-1 font-mono text-[11px] text-grey">{bits.join("  ·  ")} — edit in json</p>;
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={clsx("rounded-full px-2.5 py-0.5 font-mono text-[11px] transition-colors", on ? "bg-ink text-paper" : "text-grey hover:text-ink")}
    >
      {children}
    </button>
  );
}
