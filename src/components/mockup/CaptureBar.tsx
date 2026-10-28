"use client";

import { useState } from "react";
import type { SettingsLite } from "./api";

// url/path + test account + "what changes?" -> capture (+ sketch).

export interface CaptureInput {
  target: string;
  accountId?: string;
  intent: string;
}

export default function CaptureBar(p: { settings: SettingsLite | null; busy: boolean; onCapture: (c: CaptureInput) => void }) {
  const [target, setTarget] = useState<string | null>(null); // null = follow settings default
  const [accountId, setAccountId] = useState("");
  const [intent, setIntent] = useState("");
  const value = target ?? p.settings?.frontendUrl ?? "";
  const accounts = p.settings?.accounts ?? [];

  const submit = () => {
    if (p.busy || !value.trim()) return;
    p.onCapture({ target: value.trim(), accountId: accountId || undefined, intent: intent.trim() });
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
        </label>
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
          placeholder="what changes? e.g. add a filter bar above the table, drop the export button"
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
        />
        <button type="submit" className="btn btn-primary shrink-0" disabled={p.busy || !value.trim()}>
          {intent.trim() ? "capture + sketch" : "capture"}
          <span className="font-mono text-[11px] opacity-60">⌘↵</span>
        </button>
      </div>
    </form>
  );
}
