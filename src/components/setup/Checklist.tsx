"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { Row } from "./api";
import { installChromium } from "./api";
import { Mark, RowIcon } from "./icons";

const spring = { type: "spring", stiffness: 420, damping: 34 } as const;

// What the scan is looking for, shown as dashed placeholders until results land.
export const PLACEHOLDERS: Row[] = [
  ["claude", "claude code"],
  ["node", "node"],
  ["chromium", "test browser"],
  ["repo", "your app"],
  ["keys", "keys"],
  ["appUrl", "app url"],
  ["migrations", "migrations"],
  ["hosts", "api hosts"],
  ["lambdamd", "lambda.md"],
].map(([id, label]) => ({ id, label, state: "warn" }));

export function Checklist({
  rows,
  shown,
  onChange,
  onInstalled,
}: {
  rows: Row[];
  shown: number; // rows past this index still read as "checking"
  onChange: (row: Row, value: string | string[]) => void;
  onInstalled: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="card divide-y divide-line overflow-hidden" aria-live="polite">
      {rows.map((r, i) => (
        <RowItem
          key={r.id}
          row={r}
          index={i}
          pending={i >= shown}
          open={open === r.id}
          toggle={() => setOpen((o) => (o === r.id ? null : r.id))}
          onSave={(v) => {
            onChange(r, v);
            setOpen(null);
          }}
          onInstalled={onInstalled}
        />
      ))}
    </ul>
  );
}

function RowItem({
  row,
  index,
  pending,
  open,
  toggle,
  onSave,
  onInstalled,
}: {
  row: Row;
  index: number;
  pending: boolean;
  open: boolean;
  toggle: () => void;
  onSave: (v: string | string[]) => void;
  onInstalled: () => void;
}) {
  const still = useReducedMotion() ?? false;
  return (
    <motion.li
      initial={still ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...spring, delay: still ? 0 : index * 0.035 }}
      className="px-4 sm:px-5"
    >
      <div className="flex min-h-[52px] items-center gap-3 py-2.5">
        <Mark state={pending ? "pending" : row.state} still={still} />
        <span className={`shrink-0 transition-colors duration-200 ${pending ? "text-grey/60" : "text-ink-2"}`}>
          <RowIcon id={row.id} />
        </span>
        <span className={`min-w-0 shrink-0 text-[14px] font-semibold transition-colors duration-200 ${pending ? "text-grey" : "text-ink"}`}>
          {row.label}
        </span>
        <div className="ml-auto flex min-w-0 items-center justify-end gap-2">
          <AnimatePresence mode="popLayout" initial={false}>
            {pending ? (
              <motion.span key="p" exit={{ opacity: 0 }} transition={{ duration: 0.12 }} className="shimmer h-5 w-20 rounded-full" />
            ) : (
              <motion.span
                key="v"
                initial={still ? { opacity: 0 } : { opacity: 0, x: 6, filter: "blur(3px)" }}
                animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                className="flex min-w-0 items-center gap-2"
              >
                <Value row={row} />
                {row.action === "install" && row.state !== "ok" ? null : row.edit ? (
                  <button
                    type="button"
                    onClick={toggle}
                    aria-expanded={open}
                    className="shrink-0 rounded-full px-2 py-1 text-[12px] text-grey transition-colors hover:bg-paper-2 hover:text-ink"
                  >
                    {open ? "close" : "change"}
                  </button>
                ) : null}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>
      {!pending && row.action === "install" && row.state !== "ok" ? <Install onDone={onInstalled} /> : null}
      <AnimatePresence initial={false}>
        {open && row.edit ? (
          <motion.div
            key="edit"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0, transition: { duration: 0.15 } }}
            transition={still ? { duration: 0 } : spring}
            className="overflow-hidden"
          >
            <Editor row={row} onSave={onSave} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.li>
  );
}

function Value({ row }: { row: Row }) {
  if (row.dots?.length)
    return (
      <span className="flex min-w-0 flex-nowrap items-center justify-end gap-x-2 whitespace-nowrap sm:gap-x-3">
        {row.dots.map((d) => (
          <span key={d.name} className="flex items-center gap-1 text-[11px] text-ink-2 sm:gap-1.5 sm:text-[12px]">
            <span className={`h-2 w-2 rounded-full ${d.ok ? "bg-ok" : "bg-line-2"}`} />
            {short(d.name)}
          </span>
        ))}
      </span>
    );
  if (!row.value) return null;
  return (
    <span className="chip min-w-0 max-w-[46vw] font-mono font-medium text-ink-2 sm:max-w-[320px]" title={row.value}>
      {row.up !== undefined ? <span className={`h-2 w-2 shrink-0 rounded-full ${row.up ? "bg-ok" : "bg-bad"}`} aria-label={row.up ? "up" : "down"} /> : null}
      <span className="truncate">{row.value}</span>
      {row.detail ? <span className="hidden shrink-0 text-grey sm:inline">· {row.detail}</span> : null}
    </span>
  );
}

// ANTHROPIC_API_KEY → anthropic
const short = (k: string) => k.replace(/_(API_KEY|BOT_TOKEN|TOKEN|KEY)$/i, "").toLowerCase();

function Editor({ row, onSave }: { row: Row; onSave: (v: string | string[]) => void }) {
  const initial = Array.isArray(row.raw) ? row.raw.join("\n") : row.raw ?? "";
  const [v, setV] = useState(initial);
  const list = row.edit === "list";
  const save = () => onSave(list ? v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean) : v.trim());
  const sugg = [...new Set(row.suggestions ?? [])].filter((x) => x && x !== v).slice(0, 5);
  return (
    <form
      className="pb-4 pl-8"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {list ? (
        <textarea
          autoFocus
          rows={3}
          className="input resize-none font-mono text-[13px]"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          }}
          placeholder="one per line"
        />
      ) : (
        <input
          autoFocus
          className="input font-mono text-[13px]"
          value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder={row.edit === "url" ? "http://localhost:3000" : "~/code/my-app"}
          spellCheck={false}
          inputMode={row.edit === "url" ? "url" : undefined}
        />
      )}
      {sugg.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {sugg.map((x) => (
            <button key={x} type="button" onClick={() => setV(x)} className="chip max-w-full font-mono font-medium text-ink-2 transition-colors hover:border-ink">
              <span className="truncate">{x.replace(/^\/Users\/[^/]+/, "~")}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-3 flex justify-end">
        <button className="btn btn-primary !py-1.5 text-[13px]">save</button>
      </div>
    </form>
  );
}

function Install({ onDone }: { onDone: () => void }) {
  const [st, setSt] = useState<"idle" | "run" | "ok" | "err">("idle");
  const [line, setLine] = useState("");
  const [pct, setPct] = useState(0);
  const go = async () => {
    setSt("run");
    try {
      const ok = await installChromium((l) => {
        setLine(l);
        const m = l.match(/(\d{1,3})%/);
        if (m) setPct(Math.min(100, Number(m[1])));
      });
      setSt(ok ? "ok" : "err");
      if (ok) onDone();
    } catch {
      setSt("err");
    }
  };
  return (
    <div className="pb-4 pl-8">
      {st === "idle" || st === "err" ? (
        <div className="flex items-center gap-3">
          <button type="button" onClick={go} className="btn btn-lilac !py-1.5 text-[13px]">
            {st === "err" ? "retry install" : "install chromium"}
          </button>
          <span className="text-[12px] text-grey">{st === "err" ? "install failed" : "~150 MB · one time"}</span>
        </div>
      ) : (
        <div>
          <div className="h-1.5 overflow-hidden rounded-full bg-paper-2">
            <div
              className={`h-full origin-left rounded-full bg-ink transition-transform duration-300 ease-out ${pct ? "" : "shimmer"}`}
              style={{ transform: `scaleX(${pct ? pct / 100 : 1})` }}
            />
          </div>
          <p className="mt-1.5 truncate font-mono text-[11px] text-grey">{st === "ok" ? "installed" : line || "starting…"}</p>
        </div>
      )}
    </div>
  );
}
