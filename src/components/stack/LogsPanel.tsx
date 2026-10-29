"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { stackApi } from "./api";

const KEEP = 200;

// Last ~200 lines of one service, tailed. Follows the bottom until you scroll up; filter is a plain substring.
export default function LogsPanel({ service, onClose }: { service: string; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [follow, setFollow] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let alive = true;
    let since = 0;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await stackApi.logs(service, since);
        if (!alive) return;
        // a restarted server starts its ring over: re-read from the top
        if (r.last < since) {
          since = 0;
          setLines([]);
        } else since = r.last ?? since;
        if (r.lines?.length) setLines((cur) => [...cur, ...r.lines.map((l) => l.line)].slice(-KEEP));
        setErr(null);
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
      if (alive) t = setTimeout(tick, 1200);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [service]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? lines.filter((l) => l.toLowerCase().includes(needle)) : lines;
  }, [lines, q]);

  useLayoutEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown, follow]);

  return (
    <div className="border-t border-line bg-paper-2/60">
      <div className="flex items-center gap-2 px-4 pb-2 pt-3">
        <span className="eyebrow">logs · {service}</span>
        <span className="flex-1" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter"
          aria-label="filter logs"
          className="w-28 rounded-full border border-line-2 bg-card px-2.5 py-0.5 font-mono text-[11px] outline-none focus:border-ink"
        />
        <button
          onClick={() => setFollow((f) => !f)}
          className={`font-mono text-[11px] transition-colors ${follow ? "text-ink" : "text-grey hover:text-ink"}`}
          title="auto-follow"
        >
          {follow ? "following" : "paused"}
        </button>
        <button onClick={onClose} aria-label="close logs" className="text-grey transition-colors hover:text-ink">
          ×
        </button>
      </div>
      <pre
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 12;
          if (atBottom !== follow) setFollow(atBottom);
        }}
        className="h-52 overflow-auto whitespace-pre-wrap break-all px-4 pb-3 font-mono text-[11px] leading-[1.55] text-ink-2"
      >
        {shown.length ? shown.join("\n") : <span className="text-grey">{err ? `couldn't read logs · ${err}` : q ? "no matching lines" : "no output yet"}</span>}
      </pre>
    </div>
  );
}
