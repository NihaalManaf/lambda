"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import type { FlowEdge, FlowNode, FlowNodeKind } from "@/lib/types";
import { Icon, KindGlyph } from "./glyphs";

// Contents of the node + edge popovers. Labels stay tiny; icons carry meaning, titles explain on hover.

const KINDS: { v: FlowNodeKind; title: string }[] = [
  { v: "start", title: "start" },
  { v: "step", title: "step" },
  { v: "decision", title: "decision" },
  { v: "end", title: "end" },
  { v: "error", title: "error the user sees" },
  { v: "external", title: "third party" },
  { v: "store", title: "store · db / cache" },
];

type Mode = "idle" | "step" | "branch" | "case";

const ease = [0.23, 1, 0.32, 1] as const;

export function NodeEditor({
  node,
  onRename,
  onKind,
  onAddStep,
  onAddBranch,
  onAddCase,
  onDelete,
}: {
  node: FlowNode;
  onRename: (label: string) => void;
  onKind: (k: FlowNodeKind) => void;
  onAddStep: (label: string) => void;
  onAddBranch: (when: string, then: string) => void;
  onAddCase: (text: string) => void;
  onDelete: () => void;
}) {
  const [label, setLabel] = useState(node.label);
  const [mode, setMode] = useState<Mode>("idle");
  const [a, setA] = useState("");
  const [b, setB] = useState("");

  const open = (m: Mode) => {
    setA("");
    setB("");
    setMode(m);
  };
  const submit = () => {
    if (mode === "step" && a.trim()) onAddStep(a);
    if (mode === "branch" && b.trim()) onAddBranch(a, b);
    if (mode === "case" && a.trim()) onAddCase(a);
  };

  return (
    <div className="space-y-2">
      <input
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onRename(label);
        }}
        aria-label="node label"
        className="w-full rounded-xl bg-paper px-3 py-2 text-[14px] font-semibold outline-none ring-lilac transition-shadow duration-150 focus:ring-2"
      />

      {/* kind: icon row mirrors the chart shapes */}
      <div className="flex justify-between rounded-xl bg-paper p-1" role="radiogroup" aria-label="node kind">
        {KINDS.map((k) => {
          const G = KindGlyph[k.v];
          const on = node.kind === k.v;
          return (
            <button
              key={k.v}
              role="radio"
              aria-checked={on}
              title={k.title}
              onClick={() => !on && onKind(k.v)}
              className={clsx(
                "relative grid h-8 flex-1 place-items-center rounded-lg transition-colors duration-150 active:scale-95",
                on ? "text-paper" : "text-ink-2 hover:text-ink",
                k.v === "error" && !on && "text-[var(--marker)]",
              )}
            >
              {on && (
                <motion.span layoutId="kind-pill" transition={{ type: "spring", duration: 0.3, bounce: 0.1 }} className="absolute inset-0 rounded-lg bg-ink" />
              )}
              <G className="relative" />
            </button>
          );
        })}
      </div>

      <AnimatePresence mode="popLayout" initial={false}>
        {mode === "idle" ? (
          <motion.div
            key="actions"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.08 } }}
            transition={{ duration: 0.16, ease }}
            className="grid grid-cols-[1fr_1fr_1fr_auto] gap-1"
          >
            <Action icon={<Icon.plus />} label="step" title="add a step after this" onClick={() => open("step")} />
            <Action icon={<Icon.branch />} label="branch" title="add a labeled branch" onClick={() => open("branch")} />
            <Action icon={<Icon.pin />} label="edge case" title="pin an edge case here" onClick={() => open("case")} />
            <button
              onClick={onDelete}
              title="delete node · reconnects around it"
              aria-label="delete node"
              className="grid size-9 place-items-center rounded-xl text-grey transition-colors duration-150 hover:bg-[#fbe9e6] hover:text-bad active:scale-95"
            >
              <Icon.trash />
            </button>
          </motion.div>
        ) : (
          <motion.form
            key={mode}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.08 } }}
            transition={{ duration: 0.16, ease }}
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setMode("idle");
              }
            }}
            className="flex items-center gap-1"
          >
            {mode === "branch" && (
              <input
                autoFocus
                value={a}
                onChange={(e) => setA(e.target.value)}
                placeholder="when"
                aria-label="branch label"
                className="w-[72px] shrink-0 rounded-xl bg-paper px-2.5 py-2 font-hand text-[14px] text-blue outline-none ring-lilac focus:ring-2"
              />
            )}
            <input
              autoFocus={mode !== "branch"}
              value={mode === "branch" ? b : a}
              onChange={(e) => (mode === "branch" ? setB : setA)(e.target.value)}
              placeholder={mode === "case" ? "what could go wrong?" : mode === "branch" ? "then…" : "next step"}
              aria-label={mode === "case" ? "edge case" : "step label"}
              className="min-w-0 flex-1 rounded-xl bg-paper px-2.5 py-2 text-[13px] outline-none ring-lilac focus:ring-2"
            />
            <button
              type="submit"
              aria-label="add"
              className="grid size-9 shrink-0 place-items-center rounded-xl bg-ink text-paper transition-transform duration-150 active:scale-95"
            >
              <Icon.arrow />
            </button>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  );
}

function Action({ icon, label, title, onClick }: { icon: React.ReactNode; label: string; title: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex h-9 items-center justify-center gap-1 rounded-xl px-1.5 text-[12px] font-semibold text-ink-2 transition-colors duration-150 hover:bg-lilac-soft hover:text-ink active:scale-[0.97]"
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

export function EdgeEditor({ edge, onLabel, onDelete }: { edge: FlowEdge; onLabel: (l: string) => void; onDelete: () => void }) {
  const [label, setLabel] = useState(edge.label ?? "");
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        onLabel(label);
      }}
    >
      <input
        autoFocus
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="label · e.g. yes"
        aria-label="edge label"
        className="min-w-0 flex-1 rounded-xl bg-paper px-2.5 py-2 font-hand text-[15px] text-blue outline-none ring-lilac focus:ring-2"
      />
      <button
        type="submit"
        aria-label="save label"
        className="grid size-9 shrink-0 place-items-center rounded-xl bg-ink text-paper transition-transform duration-150 active:scale-95"
      >
        <Icon.check />
      </button>
      <button
        type="button"
        onClick={onDelete}
        title="delete edge"
        aria-label="delete edge"
        className="grid size-9 shrink-0 place-items-center rounded-xl text-grey transition-colors duration-150 hover:bg-[#fbe9e6] hover:text-bad active:scale-95"
      >
        <Icon.trash />
      </button>
    </form>
  );
}
