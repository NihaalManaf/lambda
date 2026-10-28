"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { Feature } from "@/lib/types";
import { FeatureCard } from "./FeatureCard";
import { EmptyState } from "./EmptyState";

export function FeatureGrid({ initial }: { initial: Feature[] }) {
  const [items, setItems] = useState(initial);

  async function remove(f: Feature) {
    const idx = items.indexOf(f);
    setItems((xs) => xs.filter((x) => x.id !== f.id)); // optimistic
    const res = await fetch(`/api/features/${f.id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok)
      setItems((xs) => {
        const next = [...xs];
        next.splice(Math.min(idx, next.length), 0, f);
        return next;
      });
  }

  return (
    <section className="mx-auto max-w-7xl px-6 pt-20 pb-28">
      <div className="mb-8 flex items-baseline justify-between border-b border-line pb-4">
        <h2 className="display text-5xl">features</h2>
        <span className="font-mono text-sm text-grey">{String(items.length).padStart(2, "0")}</span>
      </div>

      {items.length === 0 ? (
        <EmptyState />
      ) : (
        <motion.ul layout className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <AnimatePresence mode="popLayout" initial>
            {items.map((f, i) => (
              <motion.li
                key={f.id}
                layout
                initial={{ opacity: 0, y: 20, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.18 } }}
                transition={{
                  type: "spring",
                  stiffness: 260,
                  damping: 26,
                  delay: Math.min(i, 8) * 0.05,
                  layout: { type: "spring", stiffness: 320, damping: 30 }, // reflow after delete: no stagger delay
                }}
              >
                <FeatureCard f={f} onDelete={() => remove(f)} />
              </motion.li>
            ))}
          </AnimatePresence>
        </motion.ul>
      )}
    </section>
  );
}
