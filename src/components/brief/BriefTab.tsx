"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { FeatureView } from "@/lib/types";
import BriefCard from "./BriefCard";

// Feature-level: the settled intake brief + the conversation that produced it (collapsed).
export default function BriefTab({ feature }: { feature: FeatureView; onChange?: (f: FeatureView) => void }) {
  const [open, setOpen] = useState(false);
  const transcript = (feature.chat ?? []).filter((m) => m.source === "intake" && (m.text.trim() || m.ask));
  const doc = feature.briefDoc;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {doc ? (
        <BriefCard brief={doc} />
      ) : (
        <div className="card p-6 md:p-8">
          <div className="eyebrow mb-3">brief</div>
          <p className="font-serif text-[22px] leading-snug text-ink">{feature.brief || feature.title}</p>
          <p className="mt-3 text-[13px] text-grey">shaped before intake existed — no settled brief.</p>
        </div>
      )}

      {transcript.length > 0 && (
        <div>
          <button
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex items-center gap-2 text-[13px] text-grey transition-colors hover:text-ink"
          >
            <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }} aria-hidden>
              ›
            </motion.span>
            intake conversation · {transcript.length}
          </button>
          <AnimatePresence initial={false}>
            {open && (
              <motion.ol
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0, transition: { duration: 0.15 } }}
                transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
                className="mt-3 space-y-3 overflow-hidden"
              >
                {transcript.map((m) => (
                  <li key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
                    <div
                      className={
                        m.role === "user"
                          ? "max-w-[80%] rounded-2xl bg-paper-2 px-3.5 py-2 text-[13px] text-ink"
                          : "max-w-[90%] whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2"
                      }
                    >
                      {m.text}
                      {m.ask && (
                        <div className="mt-1.5">
                          <div className="text-ink">{m.ask.question}</div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {m.ask.options.map((o) => (
                              <span key={o} className="chip !text-[11px] !font-normal">
                                {o}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </motion.ol>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
