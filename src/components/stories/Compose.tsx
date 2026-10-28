"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import type { AcceptanceDraft } from "@/lib/ops-drafts";
import type { Priority } from "@/lib/types";
import { Icon, Meter, RoleChip, asA } from "./bits";

const ease = [0.23, 1, 0.32, 1] as const;

// "+ story" ghost tile → inline as a / i want / so that. Enter saves and stays open for the next one.
export function QuickAdd({
  open,
  onOpen,
  onClose,
  onAdd,
  defaultRole,
  defaultPriority = "should",
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onAdd: (s: { role: string; want: string; soThat: string; priority: Priority }) => void;
  defaultRole: string;
  defaultPriority?: Priority;
}) {
  const [role, setRole] = useState(defaultRole);
  const [want, setWant] = useState("");
  const [soThat, setSoThat] = useState("");
  const [priority, setPriority] = useState<Priority>(defaultPriority);
  const [added, setAdded] = useState(0);
  const wantRef = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) requestAnimationFrame(() => wantRef.current?.focus());
  }, [open]);

  const submit = () => {
    if (!want.trim()) return wantRef.current?.focus();
    onAdd({ role: role.trim() || "user", want: want.trim(), soThat: soThat.trim(), priority });
    setWant("");
    setSoThat("");
    setAdded((n) => n + 1);
    wantRef.current?.focus();
  };
  const keys = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape") onClose();
  };

  return (
    <AnimatePresence initial={false} mode="popLayout">
      {open ? (
        <motion.div
          key="form"
          ref={box}
          layout
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          transition={{ duration: 0.22, ease }}
          onBlur={(e) => {
            // close when focus leaves the form and nothing was typed
            if (!box.current?.contains(e.relatedTarget as Node) && !want.trim() && !soThat.trim()) onClose();
          }}
          className="card mt-3 border-ink/30 p-3.5 shadow-[0_0_0_3px_rgba(231,163,255,.35)]"
        >
          <label className="flex items-center gap-1.5 text-[12px] text-grey">
            <span>{asA(role || "user")}</span>
            <RoleChip role={role || "user"}>
              <input
                value={role}
                onChange={(e) => setRole(e.target.value)}
                onKeyDown={keys}
                placeholder="role"
                aria-label="role"
                className="w-full min-w-0 bg-transparent text-[12px] font-semibold text-ink-2 outline-none [field-sizing:content]"
              />
            </RoleChip>
          </label>
          <input
            ref={wantRef}
            value={want}
            onChange={(e) => setWant(e.target.value)}
            onKeyDown={keys}
            placeholder="i want to…"
            aria-label="i want"
            className="mt-2 w-full bg-transparent font-serif text-[19px] leading-snug text-ink outline-none placeholder:text-grey/60"
          />
          <input
            value={soThat}
            onChange={(e) => setSoThat(e.target.value)}
            onKeyDown={keys}
            placeholder="so that…"
            aria-label="so that"
            className="mt-1 w-full bg-transparent text-[12.5px] text-ink-2 outline-none placeholder:text-grey/60"
          />
          <div className="mt-3 flex items-center justify-between gap-2">
            <Meter p={priority} onPick={setPriority} big />
            <div className="flex items-center gap-2">
              <AnimatePresence>
                {added > 0 && (
                  <motion.span key={added} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="font-mono text-[10.5px] text-ok">
                    +{added}
                  </motion.span>
                )}
              </AnimatePresence>
              <button
                type="button"
                onClick={submit}
                disabled={!want.trim()}
                className="inline-flex items-center gap-1 rounded-full bg-ink px-2.5 py-1 font-mono text-[11px] text-paper transition-[transform,opacity] duration-150 active:scale-[0.97] disabled:opacity-30"
              >
                add ↵
              </button>
            </div>
          </div>
        </motion.div>
      ) : (
        <motion.button
          key="ghost"
          layout
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.1 } }}
          onClick={onOpen}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-[18px] border border-dashed border-line-2 py-3 text-xs font-semibold text-grey transition-[color,border-color,transform] duration-150 hover:border-ink hover:text-ink active:scale-[0.98]"
        >
          <Icon name="plus" size={13} /> story
        </motion.button>
      )}
    </AnimatePresence>
  );
}

// G / W / T inline form (+ start path, optional steps). Enter saves; steps take one per line.
export function CriterionForm({ onAdd, onClose }: { onAdd: (c: AcceptanceDraft) => void; onClose: () => void }) {
  const [d, setD] = useState<AcceptanceDraft>({ given: "", when: "", then: "", startPath: "/", steps: [] });
  const [stepsText, setStepsText] = useState("");
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const ok = d.when.trim() && d.then.trim();
  const submit = () => {
    if (!ok) return;
    onAdd({ ...d, steps: stepsText.split("\n").map((s) => s.trim()).filter(Boolean) });
    onClose();
  };
  const keys = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") onClose();
    if (e.key === "Enter" && (!(e.target instanceof HTMLTextAreaElement) || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={{ duration: 0.22, ease }}
      className="rounded-2xl border border-ink/30 bg-card p-4 shadow-[0_0_0_3px_rgba(231,163,255,.35)]"
      onKeyDown={keys}
    >
      <div className="eyebrow mb-2.5">new criterion</div>
      <div className="grid gap-1.5 sm:grid-cols-3">
        {GWT.map((g, i) => (
          <label key={g.k} className={clsx("flex items-center gap-1.5 rounded-xl px-2.5 py-2", g.bg)}>
            <Icon name={g.k} size={13} className="text-ink-2" />
            <span className="font-mono text-[10px] uppercase tracking-wider text-grey">{g.k}</span>
            <input
              ref={i === 0 ? first : undefined}
              value={d[g.k]}
              onChange={(e) => setD({ ...d, [g.k]: e.target.value })}
              placeholder={g.ph}
              aria-label={g.k}
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-grey/60"
            />
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className="eyebrow">browser test</span>
        <span className="inline-flex items-center gap-1 rounded-full bg-ink px-2 py-0.5 font-mono text-[11.5px] text-paper">
          <Icon name="globe" size={11} />
          <input
            value={d.startPath}
            onChange={(e) => setD({ ...d, startPath: e.target.value })}
            aria-label="start path"
            className="bg-transparent outline-none [field-sizing:content]"
          />
        </span>
      </div>
      <textarea
        value={stepsText}
        onChange={(e) => setStepsText(e.target.value)}
        rows={3}
        placeholder={"click 'new campaign'\nfill 'name' with 'q3'\nexpect toast 'saved'"}
        aria-label="browser steps, one per line"
        className="mt-2 w-full resize-none rounded-xl border border-line bg-paper px-3 py-2 font-mono text-[12px] leading-relaxed outline-none placeholder:text-grey/50 focus:border-ink"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <span className="mr-auto font-mono text-[10.5px] text-grey">↵ save · esc cancel</span>
        <button type="button" onClick={onClose} className="btn btn-ghost !px-3 !py-1 !text-xs">
          cancel
        </button>
        <button type="button" onClick={submit} disabled={!ok} className="btn btn-primary !px-3 !py-1 !text-xs">
          add
        </button>
      </div>
    </motion.div>
  );
}

export const GWT = [
  { k: "given", bg: "bg-paper-2", ph: "signed in host" },
  { k: "when", bg: "bg-lilac-soft", ph: "clicks 'new'" },
  { k: "then", bg: "bg-[#e3f1e8]", ph: "sees the form" },
] as const;
