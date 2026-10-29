"use client";

import { useState } from "react";
import clsx from "clsx";
import { cmdText, wiringOf, type LocalRef, type StackPlan, type StackService } from "./api";
import { RoleIcon } from "./bits";

// The plan, read-only, as a visual list: what runs, what gets set up, who talks to whom, which env files come along.
// full = the approval view: every field that can change what runs is on screen — commands untruncated, every env
// KEY=value, port flags, readiness, shell lines — plus the server's warnings. Nothing approvable stays hidden.
export default function PlanView({
  plan,
  warnings = [],
  localRefs = [],
  full,
}: {
  plan: StackPlan;
  warnings?: string[];
  localRefs?: LocalRef[];
  full?: boolean;
}) {
  const wiring = wiringOf(plan);
  return (
    <div className="space-y-4">
      {warnings.length > 0 && (
        <div className="rounded-[12px] border border-warn/40 bg-warn/[0.06] px-3 py-2" data-testid="plan-warnings">
          <div className="eyebrow mb-1 !text-warn">look twice</div>
          <ul className="space-y-0.5">
            {warnings.map((w) => (
              <li key={w} className="font-mono text-[11px] leading-snug text-ink-2">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Group label="services">
        {plan.services.map((s) => (
          <li key={s.name} className="py-2">
            <div className="flex items-center gap-2 text-[13px] text-ink">
              <RoleIcon role={s.role} className="text-grey" />
              <span>{s.name}</span>
              <span className="font-mono text-[11px] text-grey">· {s.cwd || "."}</span>
              <span className="ml-auto flex items-center gap-1">
                {s.shell && <span className="chip !py-0 font-mono text-[10px] text-warn">shell</span>}
                {s.optional && <span className="chip !py-0 font-mono text-[10px] text-grey">optional</span>}
              </span>
            </div>
            <Cmd text={cmdText(s.cmd) + portSuffix(s)} full={full} />
            {full && <Meta s={s} />}
            {full && <EnvList vars={plan.env[s.name]} />}
          </li>
        ))}
      </Group>

      {plan.setup.length > 0 && (
        <Group label="setup">
          {plan.setup.map((s) => (
            <li key={s.name} className="py-1.5">
              <div className="flex items-baseline gap-2">
                <span className="text-[12.5px] text-ink">{s.name}</span>
                <span className="font-mono text-[11px] text-grey">· {s.cwd || "."}</span>
                {s.shell && <span className="chip !py-0 font-mono text-[10px] text-warn">shell</span>}
                {s.skipIf && <span className="ml-auto truncate font-mono text-[10.5px] text-grey">skip if {s.skipIf}</span>}
              </div>
              <Cmd text={cmdText(s.cmd)} flush full={full} />
            </li>
          ))}
        </Group>
      )}

      {/* env set for services the plan doesn't list (the server rejects these; shown so nothing is invisible) */}
      {full && Object.keys(plan.env).some((k) => !plan.services.some((s) => s.name === k)) && (
        <Group label="env for unknown services">
          {Object.entries(plan.env)
            .filter(([k]) => !plan.services.some((s) => s.name === k))
            .map(([k, vars]) => (
              <li key={k} className="py-1.5">
                <span className="font-mono text-[11px] text-bad">{k}</span>
                <EnvList vars={vars} />
              </li>
            ))}
        </Group>
      )}

      {!full && wiring.length > 0 && (
        <Group label="wiring">
          {wiring.map((w) => (
            <li key={`${w.from}>${w.to}`} className="flex items-center gap-2 py-1.5 text-[13px]">
              <span className="text-ink">{w.from}</span>
              <svg width="22" height="8" viewBox="0 0 22 8" aria-hidden className="shrink-0 text-grey">
                <path d="M1 4h19M16 1l3.5 3L16 7" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="text-ink">{w.to}</span>
              {w.env && <span className="ml-auto truncate font-mono text-[10.5px] text-grey">{w.env}</span>}
            </li>
          ))}
        </Group>
      )}

      {plan.envFiles.length > 0 && (
        <div>
          <div className="eyebrow mb-1.5">env files copied</div>
          <div className="flex flex-wrap gap-1.5">
            {plan.envFiles.map((f) => (
              <span key={f} className="chip font-mono text-[11px] text-ink-2">
                {f}
              </span>
            ))}
          </div>
        </div>
      )}

      {localRefs.length > 0 && (
        <div data-testid="plan-localrefs">
          <div className="eyebrow mb-1">still points at your servers</div>
          <ul className="space-y-0.5">
            {localRefs.map((r) => (
              <li key={`${r.file}:${r.key}`} className="font-mono text-[11px] leading-snug text-ink-2">
                <span className="text-ink">{r.key}</span> <span className="text-grey">in {r.file}</span> → <span className="text-warn">your :{r.port}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11.5px] text-grey">the plan doesn&apos;t override these; code that reads them calls your own server.</p>
        </div>
      )}

      {plan.notes.length > 0 && (
        <div>
          <div className="eyebrow mb-1">notes</div>
          <ul className="space-y-1">
            {plan.notes.map((n, i) => (
              <li key={i} className="text-[12.5px] leading-snug text-ink-2">
                {n}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// what lambda appends: `--port <n>` (or `-port=<n>`)
const portSuffix = (s: StackService) => (s.port?.arg ? ` ${s.port.arg}${s.port.arg.endsWith("=") ? "" : " "}<port>` : "");

function Meta({ s }: { s: StackService }) {
  const bits = [
    s.port?.env ? `port → $${s.port.env}` : s.port ? "port" : null,
    s.extraPorts?.length ? `extra ports: ${s.extraPorts.join(", ")}` : null,
    s.ready?.path ? `ready: GET ${s.ready.path}${s.ready.status ? ` = ${s.ready.status}` : ""}` : s.ready?.log ? `ready: log /${s.ready.log}/` : "ready: alive 2s",
    s.ready?.timeoutSec ? `${s.ready.timeoutSec}s` : null,
  ].filter(Boolean);
  return <p className="mt-0.5 break-all pl-[22px] font-mono text-[10.5px] text-grey">{bits.join(" · ")}</p>;
}

// every KEY=value the plan sets for a service; wiring = resolves to one of lambda's own ports
function EnvList({ vars }: { vars?: Record<string, string> }) {
  const rows = Object.entries(vars ?? {});
  if (!rows.length) return null;
  return (
    <ul className="mt-1 space-y-px pl-[22px]">
      {rows.map(([k, v]) => {
        const wiring = /\$\{(url|port)/.test(v);
        return (
          <li key={k} className="flex items-baseline gap-2 font-mono text-[11px]">
            <span className="min-w-0 flex-1 break-all text-ink-2">
              <span className="text-ink">{k}</span>={v}
            </span>
            <span className={clsx("shrink-0 text-[10px]", wiring ? "text-grey" : "text-ink-2")}>{wiring ? "wiring" : "set by plan"}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="eyebrow mb-0.5">{label}</div>
      <ul className="divide-y divide-line">{children}</ul>
    </div>
  );
}

// one mono line, truncated; click to see all of it. full: always all of it (the approval view)
function Cmd({ text, flush, full }: { text: string; flush?: boolean; full?: boolean }) {
  const [open, setOpen] = useState(false);
  const shown = full || open;
  const cls = clsx("mt-1 block w-full min-w-0 text-left font-mono text-[11.5px] text-ink-2", !flush && "pl-[22px]", shown ? "whitespace-pre-wrap break-all" : "truncate");
  if (full) return <p className={cls}>{text}</p>;
  return (
    <button type="button" onClick={() => setOpen((o) => !o)} title={open ? undefined : text} aria-expanded={open} className={clsx(cls, "transition-colors hover:text-ink")}>
      {text}
    </button>
  );
}
