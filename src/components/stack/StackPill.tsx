"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Sculptor from "@/components/Sculptor";
import { isUp, portUrl, stackApi, uptime, useStack, type ServiceRow, type StackView } from "./api";
import { Dot, RoleIcon } from "./bits";
import LogsPanel from "./LogsPanel";
import PlanView from "./PlanView";

// Lambda's own copy of the app (frontend + api + qstash…) on free ports. A tiny pill in the header; click for the sheet.
export default function StackPill({ featureId, compact }: { featureId?: string; compact?: boolean }) {
  const { view, act, error, setError, missing } = useStack(featureId);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (missing || !view?.repo) return null; // no repo configured: nothing to host

  return (
    <div ref={root} className="relative inline-flex">
      <button
        onClick={() => {
          setOpen((o) => !o);
          setError(null);
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="stack-pill"
        className={clsx(
          "inline-flex items-center gap-2 rounded-full border bg-card font-mono transition-[transform,border-color] duration-150 active:scale-[0.97]",
          compact ? "px-2.5 py-[3px] text-[10.5px]" : "px-3 py-1 text-[11px]",
          view.phase === "needs-approval" ? "border-ink text-ink" : "border-line-2 text-ink-2 hover:border-ink",
        )}
      >
        <PillLabel view={view} />
        {view.approved && view.services.length > 0 && (
          <span className="flex items-center gap-1" aria-hidden>
            {view.services.map((s) => (
              <Dot key={s.name} status={s.status} />
            ))}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="local stack"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12 } }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            style={{ transformOrigin: "top left" }}
            className="card z-40 overflow-hidden shadow-[0_18px_50px_-24px_rgba(24,24,24,0.35)] max-sm:fixed max-sm:inset-x-4 max-sm:top-[72px] sm:absolute sm:left-0 sm:top-[calc(100%+8px)] sm:w-[400px]"
          >
            <Sheet view={view} act={act} error={error} featureId={featureId} onClose={() => setOpen(false)} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const PHASE_WORD: Partial<Record<StackView["phase"], string>> = {
  setup: "setting up…",
  starting: "starting…",
  running: "running",
  partial: "partly up",
  stopped: "stopped",
  error: "crashed",
};

function PillLabel({ view }: { view: StackView }) {
  if (view.phase === "planning")
    return (
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-lilac" />
        mapping stack…
      </span>
    );
  if (view.phase === "needs-approval")
    return (
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-lilac" />
        approve local stack
      </span>
    );
  if (!view.plan) return <span className={view.phase === "error" ? "text-bad" : undefined}>local stack</span>;
  return (
    <span>
      app · <span className={view.phase === "error" ? "text-bad" : undefined}>{PHASE_WORD[view.phase]}</span>
    </span>
  );
}

type Act = (fn: () => Promise<unknown>) => Promise<boolean>;

function Sheet({ view, act, error, featureId, onClose }: { view: StackView; act: Act; error: string | null; featureId?: string; onClose: () => void }) {
  const [logs, setLogs] = useState<string | null>(view.phase === "setup" ? "setup" : null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    await act(fn);
    setBusy(null);
  };
  const ro = view.foreign; // the other lambda runs it: look, don't touch

  const head = (
    <div className="flex items-baseline gap-2 px-4 pb-2 pt-3.5">
      <span className="eyebrow">local stack</span>
      <span className="truncate font-mono text-[11px] text-grey" title={view.repo ?? undefined}>
        {view.repo?.split("/").pop()}
      </span>
      {ro && <span className="ml-auto font-mono text-[10.5px] text-grey">run by the other lambda · read-only</span>}
    </div>
  );
  const err = error && <p className="px-4 pb-2 font-mono text-[11px] text-bad">{error}</p>;

  if (!view.plan) {
    return (
      <>
        {head}
        <div className="flex flex-col items-center gap-3 px-4 pb-5 pt-1 text-center">
          {view.planning ? (
            <>
              <Sculptor size="xs" />
              <p className="display text-xl">
                mapping your <span className="italic">stack</span>…
              </p>
              <p className="font-mono text-[11px] text-grey">reading AGENTS.md, package.json, procfiles</p>
            </>
          ) : (
            <>
              <p className="display text-xl">
                no <span className="italic">plan</span> yet
              </p>
              {view.record?.planError && <p className="font-mono text-[11px] text-bad">{view.record.planError}</p>}
              <button className="btn btn-primary !py-1.5 text-[13px]" disabled={busy === "plan"} onClick={() => run("plan", stackApi.plan)}>
                map my stack
              </button>
            </>
          )}
        </div>
        {err}
      </>
    );
  }

  if (!view.approved) {
    return (
      <>
        {head}
        <div className="max-h-[56vh] overflow-auto px-4 pb-3">
          <PlanView plan={view.plan} warnings={view.warnings} localRefs={view.localRefs} full />
        </div>
        <div className="border-t border-line px-4 py-3">
          <p className="mb-2.5 text-[12.5px] text-ink-2">runs these commands from your repo on free ports.</p>
          {err}
          <div className="flex items-center gap-2">
            <button
              className="btn btn-primary !py-1.5 text-[13px]"
              data-testid="stack-approve"
              disabled={!!busy || view.planning || !view.planHash}
              onClick={() =>
                run("approve", async () => {
                  await stackApi.approve(view.planHash);
                  await stackApi.start(undefined, featureId);
                })
              }
            >
              {busy === "approve" ? "starting…" : "approve & start"}
            </button>
            <Link href="/settings#stack" onClick={onClose} className="btn btn-ghost !py-1.5 text-[13px]">
              edit in settings
            </Link>
          </div>
        </div>
      </>
    );
  }

  const front = view.services.find((s) => s.role === "frontend" && s.status === "ready");
  const appUrl = front ? front.url ?? portUrl(front.port) : undefined;
  const anyUp = view.services.some((s) => isUp(s.status)) || view.phase === "setup";

  return (
    <>
      {head}
      {view.phase === "setup" && (
        <p className="flex items-center gap-2 px-4 pb-2 font-mono text-[11px] text-grey">
          <Dot status="starting" /> copying env files + running setup
        </p>
      )}
      {view.state?.error && !anyUp && (
        <p className="truncate px-4 pb-2 font-mono text-[11px] text-bad" title={view.state.error}>
          {view.state.error}
        </p>
      )}
      <ul className="divide-y divide-line border-y border-line">
        {view.services.map((s) => (
          <Row
            key={s.name}
            s={s}
            busy={busy}
            ro={ro}
            logsOpen={logs === s.name}
            onLogs={() => setLogs((l) => (l === s.name ? null : s.name))}
            onRun={(op) => run(`${op}:${s.name}`, () => stackApi[op](s.name))}
          />
        ))}
      </ul>
      <AnimatePresence initial={false}>
        {logs && !ro && (
          <motion.div key={logs} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.1 } }} transition={{ duration: 0.16 }}>
            <LogsPanel service={logs} onClose={() => setLogs(null)} />
          </motion.div>
        )}
      </AnimatePresence>
      {err && <div className="pt-2">{err}</div>}
      <div className="flex items-center gap-3 px-4 py-3">
        {appUrl && (
          <a href={appUrl} target="_blank" rel="noreferrer" className="btn btn-primary !py-1.5 text-[13px]">
            open app ↗
          </a>
        )}
        {!ro && (
          <TextBtn active={logs === "setup"} onClick={() => setLogs((l) => (l === "setup" ? null : "setup"))}>
            setup log
          </TextBtn>
        )}
        <span className="flex-1" />
        {ro ? null : anyUp ? (
          <>
            <TextBtn disabled={!!busy} onClick={() => run("restart", () => stackApi.restart())}>
              restart all
            </TextBtn>
            <TextBtn disabled={!!busy} onClick={() => run("stop", () => stackApi.stop())}>
              stop all
            </TextBtn>
          </>
        ) : (
          <button className="btn btn-primary !py-1.5 text-[13px]" disabled={!!busy} onClick={() => run("start", () => stackApi.start(undefined, featureId))}>
            {busy === "start" ? "starting…" : "start"}
          </button>
        )}
      </div>
    </>
  );
}

function Row({
  s,
  busy,
  ro,
  logsOpen,
  onLogs,
  onRun,
}: {
  s: ServiceRow;
  busy: string | null;
  ro: boolean;
  logsOpen: boolean;
  onLogs: () => void;
  onRun: (op: "start" | "stop" | "restart") => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (s.status !== "ready") return;
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, [s.status]);
  const url = s.url ?? portUrl(s.port);
  const failed = s.status === "crashed" || s.status === "error";

  return (
    <li className="flex items-center gap-2.5 px-4 py-2.5" data-service={s.name}>
      <Dot status={s.status} />
      <RoleIcon role={s.role} className="text-grey" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] text-ink">{s.name}</span>
          {s.port && url && (
            <a href={url} target="_blank" rel="noreferrer" className="font-mono text-[11px] text-grey underline-offset-2 transition-colors hover:text-blue hover:underline">
              :{s.port}
            </a>
          )}
          {s.status === "ready" && <span className="font-mono text-[10.5px] text-grey/80">{uptime(s.startedAt, now)}</span>}
          {s.status === "starting" && <span className="font-mono text-[10.5px] text-warn">starting</span>}
          {s.status === "stopped" && s.optional && <span className="font-mono text-[10.5px] text-grey/70">optional</span>}
        </div>
        {failed && s.error && (
          <p className="truncate font-mono text-[10.5px] text-bad" title={s.error}>
            {s.error}
          </p>
        )}
      </div>
      {!ro && (
        <div className="flex items-center gap-2.5">
          <TextBtn active={logsOpen} onClick={onLogs}>
            logs
          </TextBtn>
          {isUp(s.status) ? (
            <>
              <TextBtn disabled={!!busy} onClick={() => onRun("restart")}>
                restart
              </TextBtn>
              <TextBtn disabled={!!busy} onClick={() => onRun("stop")}>
                stop
              </TextBtn>
            </>
          ) : (
            <TextBtn disabled={!!busy} onClick={() => onRun(failed ? "restart" : "start")}>
              {failed ? "retry" : "start"}
            </TextBtn>
          )}
        </div>
      )}
    </li>
  );
}

function TextBtn({ children, onClick, disabled, active }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "font-mono text-[11px] transition-[color,transform] duration-150 active:scale-[0.97] disabled:opacity-40",
        active ? "text-ink underline underline-offset-2" : "text-grey hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
