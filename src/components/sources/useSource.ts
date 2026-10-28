"use client";
import { useEffect, useState } from "react";
import type { SourceResult } from "@/lib/sources/types";

// Debounced, abortable fetch of a /api/sources/* endpoint. Keeps last items while refetching (no flash).
export function useSource<T>(endpoint: string, q: string, delay = 250) {
  const [state, setState] = useState<SourceResult<T> & { loading: boolean }>({
    items: [],
    connected: true,
    loading: true,
  });

  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setState((s) => ({ ...s, loading: true }));
      try {
        const res = await fetch(`${endpoint}${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`, {
          signal: ctrl.signal,
        });
        const json = (await res.json()) as SourceResult<T>;
        setState({ ...json, items: json.items ?? [], loading: false });
      } catch (e) {
        if ((e as Error).name !== "AbortError")
          setState((s) => ({ ...s, loading: false, error: "couldn't reach source" }));
      }
    }, q ? delay : 0);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [endpoint, q, delay]);

  return state;
}

export function ago(iso: string | number) {
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (86400 * 30))}mo`;
}

export const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
