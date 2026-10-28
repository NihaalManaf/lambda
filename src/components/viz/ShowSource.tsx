"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import { Icon } from "./icons";

// The only place raw SQL / code is visible: a 20px </> toggle that opens a mono drawer.
// Open/closed is remembered per browser (closed by default); source loads lazily on open.

const KEY = "lambda:show-source";
const EVT = "lambda:show-source";

const read = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
const subscribe = (cb: () => void) => {
  window.addEventListener(EVT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVT, cb);
    window.removeEventListener("storage", cb);
  };
};
const write = (v: boolean) => {
  try {
    localStorage.setItem(KEY, v ? "1" : "0");
  } catch {}
  window.dispatchEvent(new Event(EVT));
};

export default function ShowSource({ load, lang, className }: { load: () => Promise<string>; lang: "sql" | "code"; className?: string }) {
  const open = useSyncExternalStore(subscribe, read, () => false);
  const [src, setSrc] = useState<{ load: () => Promise<string>; text: string | null; error?: boolean } | null>(null);
  const text = src?.load === load ? src.text : null;
  const failed = src?.load === load && src.error;

  useEffect(() => {
    if (!open) return;
    let live = true;
    load().then(
      (t) => live && setSrc({ load, text: t }),
      () => live && setSrc({ load, text: null, error: true }),
    );
    return () => {
      live = false;
    };
  }, [open, load]);

  return (
    <div className={clsx("relative", className)}>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => write(!open)}
          title={open ? "hide source" : `show ${lang}`}
          aria-pressed={open}
          className={clsx(
            "grid h-5 w-5 place-items-center rounded-md border transition-colors duration-150",
            open ? "border-ink bg-ink text-paper" : "border-line-2 bg-card text-grey hover:border-ink hover:text-ink",
          )}
        >
          <Icon name="code" size={12} />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <pre className="mt-2 max-h-80 overflow-auto rounded-xl border border-line bg-paper-2 p-3 font-mono text-[11px] leading-relaxed text-ink-2">
              {text ?? (failed ? "—" : <span className="shimmer block h-16 rounded-md" />)}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
