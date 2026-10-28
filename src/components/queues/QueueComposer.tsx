"use client";

import { useState } from "react";
import { Icon } from "@/components/viz/icons";

// one line to describe the change, or pull it straight from the repo's uncommitted diff

export default function QueueComposer({ busy, onPrompt, onGit }: { busy: boolean; onPrompt: (text: string) => void; onGit: () => void }) {
  const [text, setText] = useState("");
  const send = () => {
    if (busy || !text.trim()) return;
    onPrompt(text.trim());
    setText("");
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex min-w-0 flex-1 basis-72 items-center rounded-full border border-line-2 bg-card pl-4 pr-1 transition-[border-color,box-shadow] duration-150 focus-within:border-ink focus-within:shadow-[0_0_0_3px_rgba(231,163,255,0.45)]">
        <input
          className="min-w-0 flex-1 bg-transparent py-2 text-[14px] outline-none placeholder:text-grey"
          placeholder="describe the queue change"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button className="btn btn-primary !px-3 !py-1.5" disabled={busy || !text.trim()} onClick={send} title="propose">
          <span aria-hidden>→</span>
        </button>
      </div>
      <button className="btn btn-ghost !py-2 text-[13px]" disabled={busy} onClick={onGit} title="from repo diff">
        <Icon name="split" size={14} /> from repo diff
      </button>
    </div>
  );
}
