"use client";

import { useState, useSyncExternalStore } from "react";
import { motion } from "motion/react";
import { DEFAULT_VIEWPORT, VIEWPORTS, type ViewportId } from "@/lib/viewports";
import type { SettingsLite } from "./api";

// url/path + device + test account + "what changes?" -> capture (+ sketch).

export interface CaptureInput {
  target: string;
  accountId?: string;
  intent: string;
  viewport: ViewportId;
}

const VP_KEY = "lambda:sketch-viewport";
const spring = { type: "spring", stiffness: 420, damping: 36 } as const;

// remembered per browser
const readVp = (): ViewportId => {
  try {
    const v = localStorage.getItem(VP_KEY);
    return VIEWPORTS.some((x) => x.id === v) ? (v as ViewportId) : DEFAULT_VIEWPORT;
  } catch {
    return DEFAULT_VIEWPORT;
  }
};
const subscribe = (cb: () => void) => {
  window.addEventListener(VP_KEY, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(VP_KEY, cb);
    window.removeEventListener("storage", cb);
  };
};
const writeVp = (v: ViewportId) => {
  try {
    localStorage.setItem(VP_KEY, v);
  } catch {}
  window.dispatchEvent(new Event(VP_KEY));
};

// understand: the marker explains what's there instead of marking changes
// appUrl: lambda's own running app (local stack). Then the field defaults to "/" — a bare path lands on it.
export default function CaptureBar(p: { settings: SettingsLite | null; appUrl?: string; busy: boolean; onCapture: (c: CaptureInput) => void; understand?: boolean }) {
  const [target, setTarget] = useState<string | null>(null); // null = follow settings default
  const [accountId, setAccountId] = useState("");
  const [intent, setIntent] = useState("");
  const viewport = useSyncExternalStore(subscribe, readVp, () => DEFAULT_VIEWPORT);
  const value = target ?? (p.appUrl ? "/" : (p.settings?.frontendUrl ?? ""));
  const onStack = Boolean(p.appUrl) && !/^https?:\/\//i.test(value.trim());
  const accounts = p.settings?.accounts ?? [];

  const submit = () => {
    if (p.busy || !value.trim()) return;
    p.onCapture({ target: value.trim(), accountId: accountId || undefined, intent: intent.trim(), viewport });
  };

  return (
    <form
      className="card flex flex-col gap-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-2 md:flex-row">
        <label className="flex flex-1 items-center gap-2">
          <span className="eyebrow shrink-0">page</span>
          <input
            className="input font-mono !text-[13px]"
            value={value}
            placeholder="/dashboard or https://…"
            onChange={(e) => setTarget(e.target.value)}
            spellCheck={false}
          />
          {onStack && (
            <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-grey" title="lambda's own copy of the app (local stack)">
              on {p.appUrl!.replace(/^https?:\/\//, "")}
            </span>
          )}
        </label>
        <div className="flex shrink-0 rounded-full border border-line-2 bg-card p-0.5" role="radiogroup" aria-label="capture size">
          {VIEWPORTS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="radio"
              aria-checked={viewport === v.id}
              title={`${v.width}×${v.height}`}
              onClick={() => writeVp(v.id)}
              className={`relative rounded-full px-3 py-1 text-[13px] font-semibold ${viewport === v.id ? "text-paper" : "text-ink-2"}`}
            >
              {viewport === v.id && <motion.span layoutId="capture-vp" transition={spring} className="absolute inset-0 rounded-full bg-ink" />}
              <span className="relative">{v.name}</span>
            </button>
          ))}
        </div>
        {accounts.length > 0 && (
          <select className="input md:!w-52" value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="log in as">
            <option value="">no login</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                as {a.label || a.email || a.id}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="flex flex-col gap-2 md:flex-row md:items-end">
        <textarea
          className="input min-h-[44px] flex-1 resize-none font-hand !text-[17px] leading-snug"
          rows={2}
          value={intent}
          placeholder={
            p.understand
              ? "what should I point out? e.g. where invites are sent from"
              : "what changes? e.g. add a filter bar above the table, drop the export button"
          }
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
        />
        <button type="submit" className="btn btn-primary shrink-0" disabled={p.busy || !value.trim()}>
          {intent.trim() ? (p.understand ? "capture + annotate" : "capture + sketch") : "capture"}
          <span className="font-mono text-[11px] opacity-60">⌘↵</span>
        </button>
      </div>
    </form>
  );
}
