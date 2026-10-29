"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StackPlan, StackPlanRecord, StackRole, StackService, StackServiceStatus, StackState } from "@/lib/types";

// Client side of the local-stack engine (src/lib/stack/**, src/app/api/stack/**). Lambda boots its own copy of
// the user's app (frontend + api + qstash…) from its worktree on free ports; the user's own servers are never touched.

export type { StackPlan, StackRole, StackService };

// one row per planned service, merged with whatever is running
export interface ServiceRow {
  name: string;
  role: StackRole;
  status: StackServiceStatus;
  port?: number;
  url?: string;
  startedAt?: string;
  error?: string;
  optional?: boolean;
}

export type StackPhase = "none" | "planning" | "needs-approval" | "stopped" | "setup" | "starting" | "running" | "partial" | "error";

export interface StackView {
  repo: string | null;
  record: StackPlanRecord | null;
  plan: StackPlan | null;
  planning: boolean;
  approved: boolean;
  state: StackState | null;
  services: ServiceRow[];
  phase: StackPhase;
  foreign: boolean; // run by the other lambda (mac app vs dev server): read-only here
  planHash: string | null; // sent back with approve: the server refuses if the stored plan isn't this one
  warnings: string[]; // things in the plan worth a second look before approving
  localRefs: LocalRef[]; // env-file keys still pointing at the developer's own servers (names + ports only)
}

export type LocalRef = { file: string; key: string; port: number };

// GET /api/stack -> { repo, record, planning, worktree, state }
type MainRes = {
  repo: string;
  record: StackPlanRecord | null;
  planHash?: string | null;
  warnings?: string[];
  localRefs?: LocalRef[];
  planning: boolean;
  worktree: string | null;
  state: StackState | null;
};
// GET /api/features/[id]/stack -> { worktree, approved, hasPlan, planning, state }
type FeatureRes = { worktree: string | null; approved: boolean; hasPlan: boolean; planning: boolean; state: StackState | null };

export const isUp = (s: StackServiceStatus) => s === "ready" || s === "starting";
export const portUrl = (port?: number) => (port ? `http://127.0.0.1:${port}` : undefined);

function phaseOf(v: { planning: boolean; plan: StackPlan | null; approved: boolean; record: StackPlanRecord | null; state: StackState | null }): StackPhase {
  if (v.planning) return "planning";
  if (!v.plan) return v.record?.planError ? "error" : "none";
  if (!v.approved) return "needs-approval";
  switch (v.state?.status) {
    case "setup":
      return "setup";
    case "starting":
      return "starting";
    case "ready":
      return "running";
    case "partial":
      return "partial";
    case "error":
      return "error";
    default:
      return "stopped";
  }
}

export function buildView(main: MainRes | null, feature?: FeatureRes | null): StackView {
  const record = main?.record ?? null;
  const plan = record?.plan ?? null;
  // the feature's stack when it runs in its own checkout; it's the main worktree's otherwise
  const state = (feature?.worktree && feature.worktree !== main?.worktree ? feature.state : main?.state) ?? null;
  const running = new Map((state?.services ?? []).map((s) => [s.name, s]));
  const services: ServiceRow[] = (plan?.services ?? []).map((p) => {
    const s = running.get(p.name);
    return {
      name: p.name,
      role: p.role,
      optional: p.optional,
      status: s?.status ?? "stopped",
      port: s?.port,
      url: s?.url,
      startedAt: s?.readyAt ?? s?.startedAt,
      error: s?.error,
    };
  });
  for (const s of state?.services ?? []) if (!services.some((x) => x.name === s.name)) services.push({ ...s, startedAt: s.readyAt ?? s.startedAt });
  const v = {
    repo: main?.repo ?? null,
    record,
    plan,
    planning: !!(main?.planning || feature?.planning),
    approved: !!record?.approved,
    state,
    services,
    foreign: !!state?.foreign,
    planHash: main?.planHash ?? null,
    warnings: main?.warnings ?? [],
    localRefs: main?.localRefs ?? [],
  };
  return { ...v, phase: phaseOf(v) };
}

export class StackError extends Error {
  constructor(
    msg: string,
    public status: number,
  ) {
    super(msg);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new StackError((data as { error?: string }).error || `${res.status}`, res.status);
  return data as T;
}
const post = <T>(url: string, body?: unknown) => call<T>(url, { method: "POST", body: JSON.stringify(body ?? {}) });

export interface LogLine {
  seq: number;
  at?: string;
  service: string;
  stream?: string;
  line: string;
}

export const stackApi = {
  get: async (featureId?: string): Promise<StackView> => {
    const [main, feature] = await Promise.all([
      call<MainRes>("/api/stack"),
      featureId ? call<FeatureRes>(`/api/features/${featureId}/stack`).catch(() => null) : Promise.resolve(null),
    ]);
    return buildView(main, feature);
  },
  plan: () => post<MainRes>("/api/stack/plan"),
  savePlan: (plan: StackPlan) => call<MainRes>("/api/stack/plan", { method: "PUT", body: JSON.stringify({ plan }) }),
  // planHash = the plan on screen; 409 "plan changed" when the stored plan moved on since the last poll
  approve: (planHash: string | null, approved = true) => post<MainRes>("/api/stack/approve", { approved, planHash }),
  // the feature's own stack start goes through its route (records the feature as a user of the stack)
  start: (service?: string, featureId?: string) =>
    featureId && !service ? post(`/api/features/${featureId}/stack`) : post("/api/stack/start", { service }),
  stop: (service?: string) => post("/api/stack/stop", { service }),
  restart: (service?: string) => post("/api/stack/restart", { service }),
  logs: (service: string, since = 0) =>
    call<{ lines: LogLine[]; last: number }>(`/api/stack/logs?service=${encodeURIComponent(service)}&since=${since}`),
};

// Polls while something is moving (planning / setup / starting), slowly otherwise; pauses when the tab is hidden.
export function useStack(featureId?: string) {
  const [view, setView] = useState<StackView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false); // no repo configured (400)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const alive = useRef(true);
  const kick = useRef<() => void>(() => undefined);

  const refresh = useCallback(async () => {
    try {
      const v = await stackApi.get(featureId);
      if (alive.current) {
        setView(v);
        setMissing(false);
        setError(null);
      }
      return v;
    } catch (e) {
      if (alive.current) {
        if (e instanceof StackError && e.status === 400) setMissing(true);
        else setError((e as Error).message);
      }
      return null;
    }
  }, [featureId]);

  useEffect(() => {
    alive.current = true;
    const loop = async () => {
      clearTimeout(timer.current);
      const v = document.hidden ? null : await refresh();
      if (!alive.current) return;
      const busy = v && ["planning", "setup", "starting"].includes(v.phase);
      timer.current = setTimeout(loop, busy ? 1500 : 5000);
    };
    kick.current = () => void loop();
    void loop();
    const wake = () => !document.hidden && void loop();
    document.addEventListener("visibilitychange", wake);
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [refresh]);

  // run a mutation, then re-read the whole view (mutations answer with partial shapes) and resume fast polling
  const act = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      kick.current();
      return true;
    } catch (e) {
      setError((e as Error).message);
      kick.current();
      return false;
    }
  }, []);

  return { view, error, missing, refresh, act, setError };
}

export function uptime(since?: string, now = Date.now()) {
  if (!since) return "";
  const s = Math.max(0, Math.round((now - new Date(since).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ---------- plan helpers ----------

const quote = (a: string) => (/^[\w@%+=:,./${}-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
export const cmdText = (cmd: string[] | string) => (Array.isArray(cmd) ? cmd.map(quote).join(" ") : cmd);

// "frontend → api" edges, read off the ${url:x} / ${port:x} placeholders in each service's env + cmd
export function wiringOf(plan: StackPlan): { from: string; to: string; env?: string }[] {
  const out: { from: string; to: string; env?: string }[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, env?: string) => {
    const k = `${from}>${to}`;
    if (from === to || seen.has(k)) return;
    seen.add(k);
    out.push({ from, to, env });
  };
  const refs = (s: string) => [...s.matchAll(/\$\{(?:url|port):([\w-]+)/g)].map((m) => m[1]);
  for (const [svc, vars] of Object.entries(plan.env ?? {})) for (const [k, v] of Object.entries(vars)) for (const to of refs(v)) add(svc, to, k);
  for (const s of plan.services) for (const to of refs(cmdText(s.cmd))) add(s.name, to);
  return out;
}
