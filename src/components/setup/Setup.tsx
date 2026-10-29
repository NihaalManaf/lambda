"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ApplyBody, Model, Question, Row, Status, Values } from "./api";
import { apply, getStatus, pickRepo, questionsFor, rowsFor, scan, valuesFor } from "./api";
import { Checklist, PLACEHOLDERS } from "./Checklist";
import { QuestionCard, type Answer } from "./Questions";
import { Finish } from "./Finish";

// start → scan (rows land one by one) → only the questions detection couldn't answer → apply → done.
// When nothing is left to ask (or the last answer lands) and nothing is missing, it saves on its own:
// the only clicks are "start" and the answers. The done screen links back to review/change.

type Phase = "idle" | "scan" | "ask" | "review" | "apply" | "done";

const spring = { type: "spring", stiffness: 300, damping: 30 } as const;
const STAGGER = 110; // ms between rows landing

export function Setup() {
  const still = useReducedMotion() ?? false;
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState<Status | null>(null);
  const [model, setModel] = useState<Model | null>(null);
  const [values, setValues] = useState<Values | null>(null);
  const [shown, setShown] = useState(0);
  const [queue, setQueue] = useState<Question[]>([]);
  const [answered, setAnswered] = useState(0);
  const [extra, setExtra] = useState<Omit<ApplyBody, keyof Values>>({}); // key / login from answers
  const [chromium, setChromium] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const auto = useRef(false); // save as soon as we land on review with nothing missing
  const applying = useRef(false); // double-click / Enter + auto can't race two applies
  const tail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getStatus().then(setStatus, () => setStatus(null));
  }, []);

  const rows: Row[] = useMemo(
    () => (model && values ? rowsFor(model, values, { chromium, key: Boolean(extra.anthropicKey) }) : PLACEHOLDERS),
    [model, values, chromium, extra.anthropicKey],
  );

  // land rows one by one once the scan returns, then hand over to the questions
  useEffect(() => {
    if (phase !== "scan" || !model || !values) return;
    const t = setTimeout(
      () => {
        if (shown < rows.length) return setShown(shown + 1);
        const q = questionsFor(model, values);
        setQueue(q);
        setPhase(q.length ? "ask" : "review");
        auto.current = true;
      },
      still || shown >= rows.length ? 0 : STAGGER,
    );
    return () => clearTimeout(t);
  }, [phase, model, values, shown, rows.length, still]);

  // bring the active card into view only when it's below the fold; the step header is sticky, so it
  // stays readable either way (scroll-margin keeps the card clear of nav + header)
  useEffect(() => {
    if (phase !== "ask" && phase !== "review") return;
    const el = tail.current;
    if (!el || el.getBoundingClientRect().bottom <= window.innerHeight - 16) return;
    el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "nearest" });
  }, [phase, queue, still]);

  const start = async () => {
    setError(null);
    setPhase("scan");
    setModel(null);
    setValues(null);
    setShown(0);
    setAnswered(0);
    setExtra({});
    auto.current = false;
    try {
      const [m] = await Promise.all([scan(), new Promise((r) => setTimeout(r, still ? 0 : 450))]);
      setModel(m);
      setValues(valuesFor(m));
    } catch (e) {
      setError((e as Error).message || "scan failed");
      setPhase("idle");
    }
  };

  // a new repo re-derives env, url, migrations and hosts — and which questions are left
  const switchRepo = async (path: string) => {
    if (!model) return;
    const r = await pickRepo(path);
    const m: Model = { ...model, repo: r.repo, plan: { ...r.plan, actions: model.plan.actions } };
    const v = valuesFor(m);
    setModel(m);
    setValues(v);
    const left = questionsFor(m, v).filter((q) => q.id !== "repo" && !(q.id === "anthropicKey" && extra.anthropicKey));
    setQueue(left);
    setPhase(left.length ? "ask" : "review");
  };

  const answer = async (a: Answer) => {
    const q = queue[0];
    if (!q || busy) return;
    setError(null);
    if (q.id === "repo" && a && typeof a.path === "string") {
      setBusy(true);
      try {
        await switchRepo(a.path);
        setAnswered((n) => n + 1);
        auto.current = true;
      } catch (e) {
        setError((e as Error).message || "couldn't read that repo");
      } finally {
        setBusy(false);
      }
      return;
    }
    if (a) {
      const { frontendUrl, ...rest } = a as { frontendUrl?: string };
      if (frontendUrl && values) setValues({ ...values, frontendUrl });
      setExtra((x) => ({ ...x, ...rest }));
    }
    setAnswered((n) => n + 1);
    const left = queue.slice(1);
    setQueue(left);
    if (!left.length) {
      setPhase("review");
      auto.current = true;
    }
  };

  const change = async (row: Row, v: string | string[]) => {
    if (!values) return;
    setError(null);
    const one = Array.isArray(v) ? v[0] ?? "" : v;
    const list = Array.isArray(v) ? v : [v];
    if (row.id === "repo") {
      if (!one || one === values.repoPath) return;
      setBusy(true);
      try {
        await switchRepo(one);
      } catch (e) {
        setError((e as Error).message || "couldn't read that repo");
      } finally {
        setBusy(false);
      }
      return;
    }
    const patch: Partial<Values> =
      row.id === "keys"
        ? { envPath: one }
        : row.id === "appUrl"
          ? { frontendUrl: one }
          : row.id === "migrations"
            ? { migrationsDir: list[0] ?? "", extraMigrationDirs: list.slice(1) }
            : row.id === "hosts"
              ? { appHosts: list }
              : {};
    setValues({ ...values, ...patch });
  };

  const finish = async () => {
    if (!values || applying.current) return;
    applying.current = true;
    auto.current = false;
    setPhase("apply");
    setError(null);
    try {
      const { migrationsDir, extraMigrationDirs, ...rest } = values;
      await apply({ ...rest, migrations: { dir: migrationsDir, extra: extraMigrationDirs }, ...extra });
      setPhase("done");
    } catch (e) {
      setError((e as Error).message || "couldn't save");
      setPhase("review");
    } finally {
      applying.current = false;
    }
  };

  const total = answered + queue.length;
  const missing = rows.some((r) => r.state === "missing");
  const blocked = rows.find((r) => r.id === "claude")?.state === "missing";

  // runs after the answer's state has committed, so `values` / `extra` are the fresh ones
  useEffect(() => {
    if (phase !== "review" || !auto.current) return;
    if (missing) {
      auto.current = false;
      return;
    }
    // a beat on "all found." so the save reads as a step, not a jump
    const t = setTimeout(() => {
      auto.current = false;
      void finish();
    }, 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on landing in review; finish reads that render's values
  }, [phase, missing]);

  // Enter anywhere on the review step finishes
  useEffect(() => {
    if (phase !== "review") return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "Enter" && !["INPUT", "TEXTAREA", "BUTTON", "A"].includes(t.tagName)) void finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <main className="mx-auto max-w-2xl px-4 pb-28 pt-10 sm:px-6 sm:pt-14">
      <AnimatePresence mode="wait" initial={false}>
        {phase === "idle" ? (
          <Intro key="intro" status={status} onStart={start} error={error} />
        ) : phase === "done" ? (
          <motion.div key="done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
            <Finish onReview={() => setPhase("review")} />
          </motion.div>
        ) : (
          <motion.div
            key="flow"
            initial={still ? { opacity: 0 } : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.18 } }}
            transition={spring}
          >
            <header className="sticky top-[57px] z-10 -mx-4 mb-6 flex items-end justify-between gap-4 bg-paper/85 px-4 pb-3 pt-3 backdrop-blur-md sm:-mx-6 sm:px-6">
              <div>
                <p className="eyebrow mb-2">λ — setup</p>
                <h1 className="display text-[2.2rem] sm:text-[2.8rem]">
                  {phase === "scan" ? (
                    <>
                      looking <em>around…</em>
                    </>
                  ) : phase === "ask" ? (
                    <>
                      {total === 1 ? "one" : total === 2 ? "two" : "a few"} <em>question{total === 1 ? "" : "s"}</em>
                    </>
                  ) : (
                    <>
                      all <em>found.</em>
                    </>
                  )}
                </h1>
              </div>
              <span className="pb-1 font-mono text-[11px] tabular-nums text-grey">
                {Math.min(shown, rows.length)}/{rows.length}
              </span>
            </header>

            <Checklist rows={rows} shown={model ? shown : 0} onChange={change} onInstalled={() => setChromium(true)} />

            <div ref={tail} className="mt-6 scroll-mb-8 scroll-mt-40">
              <AnimatePresence mode="wait" initial={false}>
                {phase === "ask" && queue[0] ? (
                  <QuestionCard key={queue[0].id} q={queue[0]} step={answered + 1} total={total} busy={busy} onAnswer={answer} />
                ) : phase === "review" || phase === "apply" ? (
                  <motion.div
                    key="review"
                    initial={still ? { opacity: 0 } : { opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={spring}
                    className="flex flex-wrap items-center justify-between gap-3"
                  >
                    <span className="text-[13px] text-grey">
                      {blocked ? "log in to claude code, then rerun" : missing ? "one thing still missing ↑" : answered ? "looks right?" : "nothing to ask."}
                    </span>
                    <button type="button" onClick={finish} disabled={phase === "apply" || busy} className="btn btn-primary px-5 py-2.5">
                      {phase === "apply" ? "saving…" : "finish setup"}
                      <kbd className="rounded border border-paper/30 px-1 font-mono text-[10px] font-normal opacity-70">↵</kbd>
                    </button>
                  </motion.div>
                ) : null}
              </AnimatePresence>
              <AnimatePresence>
                {error ? (
                  <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} role="alert" className="mt-3 text-right text-[13px] text-bad">
                    {error}
                  </motion.p>
                ) : null}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}

function Intro({ status, onStart, error }: { status: Status | null; onStart: () => void; error: string | null }) {
  const still = useReducedMotion() ?? false;
  return (
    <motion.section
      initial={still ? { opacity: 0 } : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={still ? { opacity: 0 } : { opacity: 0, y: -8, filter: "blur(4px)", transition: { duration: 0.18 } }}
      transition={spring}
      className="relative isolate grid min-h-[60vh] grid-cols-1 content-center items-center gap-6 sm:grid-cols-[1fr_auto]"
    >
      <div className="pointer-events-none absolute right-0 top-1/2 -z-10 h-[320px] w-[min(420px,90vw)] -translate-y-1/2 rounded-full bg-lilac-soft/70 blur-3xl" />
      <div className="order-2 sm:order-1">
        <p className="eyebrow mb-5">λ — setup</p>
        <h1 className="display text-[3rem] sm:text-[4.4rem]">
          set up <em>lambda.</em>
        </h1>
        <p className="mt-4 text-[15px] text-ink-2">mostly automatic. few questions.</p>
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <button type="button" autoFocus onClick={onStart} className="btn btn-primary px-7 py-3.5 text-[16px] outline-none focus-visible:ring-4 focus-visible:ring-lilac/60">
            start setup <span aria-hidden>→</span>
          </button>
          {status?.configured ? (
            <span className="flex items-center gap-1.5 text-[12px] text-grey">
              <span className="h-2 w-2 rounded-full bg-ok" /> already set · rerun anytime
            </span>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="mt-4 text-[13px] text-bad">
            {error}
          </p>
        ) : null}
      </div>
      {/* she faces left, toward the button */}
      <motion.div
        aria-hidden
        initial={still ? { opacity: 0 } : { opacity: 0, x: 30 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ type: "spring", stiffness: 70, damping: 18, delay: 0.1 }}
        className="order-1 mx-auto w-[120px] sm:order-2 sm:w-[230px]"
      >
        <Image src="/art/muse-orb.webp" alt="" width={900} height={1393} priority className="statue-fade" />
      </motion.div>
    </motion.section>
  );
}
