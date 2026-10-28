"use client";

import { AnimatePresence, motion } from "motion/react";
import type { Annotation } from "@/lib/types";
import KindIcon from "./KindIcon";
import { KINDS } from "./marks";

// Numbered list of marks; the selected one opens into a tiny editor.

export default function AnnotationList(p: {
  annotations: Annotation[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onEdit: (a: Annotation) => void;
  onDelete: (id: string) => void;
}) {
  if (!p.annotations.length)
    return <p className="font-hand text-lg text-grey">no marks yet — sketch it or draw a box.</p>;

  return (
    <ul className="flex flex-col gap-1.5" onMouseLeave={() => p.onHover(null)}>
      <AnimatePresence initial={false}>
        {p.annotations.map((a, i) => {
          const open = a.id === p.selectedId;
          return (
            <motion.li
              key={a.id}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ type: "spring", stiffness: 500, damping: 38 }}
              onMouseEnter={() => p.onHover(a.id)}
              className={`overflow-hidden rounded-xl border transition-colors ${open ? "border-ink bg-card" : "border-line bg-card/60 hover:border-line-2"}`}
            >
              <button className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => p.onSelect(open ? null : a.id)}>
                <span className="font-mono text-[11px] text-grey">{i + 1}</span>
                <KindIcon kind={a.kind} />
                <span className="truncate font-hand text-[17px] leading-tight">{a.newText && a.kind === "change-text" ? `→ ${a.newText}` : a.label}</span>
              </button>

              <AnimatePresence initial={false}>
                {open && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ type: "spring", stiffness: 420, damping: 40 }}
                  >
                    <div className="flex flex-col gap-2 px-3 pb-3">
                      <div className="flex flex-wrap gap-1">
                        {KINDS.map((k) => (
                          <button
                            key={k.kind}
                            onClick={() =>
                              p.onEdit({
                                ...a,
                                kind: k.kind,
                                to: k.kind === "move" ? a.to ?? { ...a.box, y: a.box.y + a.box.h + 60 } : a.to,
                              })
                            }
                            className={`chip transition-colors ${a.kind === k.kind ? "!border-ink !bg-ink !text-paper" : "hover:border-ink"}`}
                          >
                            <KindIcon kind={k.kind} size={12} />
                            {k.name}
                          </button>
                        ))}
                      </div>
                      <input
                        autoFocus
                        className="input font-hand !text-[17px]"
                        value={a.label}
                        maxLength={48}
                        placeholder="label (≤ 6 words)"
                        onChange={(e) => p.onEdit({ ...a, label: e.target.value })}
                      />
                      {a.kind === "change-text" && (
                        <input
                          className="input font-hand !text-[17px]"
                          value={a.newText ?? ""}
                          maxLength={80}
                          placeholder="new copy"
                          onChange={(e) => p.onEdit({ ...a, newText: e.target.value })}
                        />
                      )}
                      <input
                        className="input !text-[13px]"
                        value={a.detail ?? ""}
                        maxLength={160}
                        placeholder="detail (optional)"
                        onChange={(e) => p.onEdit({ ...a, detail: e.target.value })}
                      />
                      <button onClick={() => p.onDelete(a.id)} className="self-start text-[12px] font-semibold text-bad hover:underline">
                        delete mark
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}
