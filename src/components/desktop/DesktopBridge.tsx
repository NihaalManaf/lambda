"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { desktop, NEW_FEATURE_EVENT } from "@/lib/desktop";

// Mac app glue: native menu → client routing, and Edit › Find… (⌘F).
// The dock badge + run notifications live in the main process (they work with the window closed).
// Inert in a plain browser.
export default function DesktopBridge() {
  const router = useRouter();
  const pathname = usePathname();
  const [finding, setFinding] = useState(false);
  const [findSeq, setFindSeq] = useState(0); // ⌘F again re-focuses + selects

  useEffect(() => {
    const d = desktop();
    if (!d) return;
    return d.onMenu((a) => {
      if (a.type === "navigate") router.push(a.path);
      else if (a.type === "new-feature") {
        if (pathname !== "/") router.push("/");
        // composer autofocuses on mount; if already home, nudge it
        requestAnimationFrame(() => window.dispatchEvent(new Event(NEW_FEATURE_EVENT)));
      } else if (a.type === "find") {
        // a page with its own search box (sources, add-context) gets that; elsewhere, find in page
        const box = [...document.querySelectorAll<HTMLInputElement>("input[data-find]")].find(
          (el) => !el.closest("[inert]") && el.checkVisibility(),
        );
        if (box) {
          box.focus();
          box.select();
        } else {
          setFinding(true);
          setFindSeq((n) => n + 1);
        }
      }
    });
  }, [router, pathname]);

  // a new page = a new search
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setFinding(false);
  }

  return <AnimatePresence>{finding && <FindBar key="find" seq={findSeq} onClose={() => setFinding(false)} />}</AnimatePresence>;
}

// ---------- find in page: CSS custom highlights, no DOM mutation, no focus stealing ----------

type HighlightRegistry = Map<string, unknown>;
const registry = () => (globalThis.CSS as unknown as { highlights?: HighlightRegistry }).highlights;
const Highlight = () => (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;

function search(q: string): Range[] {
  const needle = q.toLowerCase();
  if (!needle) return [];
  const out: Range[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const el = n.parentElement;
      if (!el || !n.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      if (el.closest("script,style,noscript,[inert],[aria-hidden='true'],[data-findbar]")) return NodeFilter.FILTER_REJECT;
      if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: false } as CheckVisibilityOptions))
        return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n && out.length < 1000; n = walker.nextNode()) {
    const text = n.nodeValue!.toLowerCase();
    for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + needle.length);
      out.push(r);
    }
  }
  return out;
}

// ::highlight() styles are injected here, not in globals.css: the css optimizer flags the pseudo-element
const FIND_CSS =
  "::highlight(lambda-find){background-color:color-mix(in srgb,var(--color-lilac,#e7a3ff) 45%,transparent)}" +
  "::highlight(lambda-find-active){background-color:var(--color-lilac,#e7a3ff);color:#181818}";
function ensureFindStyle() {
  if (document.getElementById("lambda-find-style")) return;
  const el = document.createElement("style");
  el.id = "lambda-find-style";
  el.textContent = FIND_CSS;
  document.head.appendChild(el);
}

function paint(all: Range[], active: number) {
  const reg = registry();
  const H = Highlight();
  if (!reg || !H) return;
  ensureFindStyle();
  reg.set("lambda-find", new H(...all));
  reg.set("lambda-find-active", all[active] ? new H(all[active]) : new H());
}
function unpaint() {
  registry()?.delete("lambda-find");
  registry()?.delete("lambda-find-active");
}

function FindBar({ seq, onClose }: { seq: number; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Range[]>([]);
  const [at, setAt] = useState(0);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [seq]);

  // search after a beat of quiet typing
  useEffect(() => {
    const t = setTimeout(() => {
      const found = search(q);
      setHits(found);
      setAt(0);
    }, 80);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    paint(hits, at);
    const r = hits[at];
    const el = r?.startContainer.parentElement;
    if (el) {
      const box = r.getBoundingClientRect();
      if (box.top < 72 || box.bottom > window.innerHeight - 24) el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [hits, at]);

  useEffect(() => unpaint, []);

  const step = (d: number) => hits.length && setAt((i) => (i + d + hits.length) % hits.length);

  return (
    <motion.div
      data-findbar
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.12 } }}
      transition={{ type: "spring", stiffness: 520, damping: 38 }}
      className="find-bar fixed right-5 top-[68px] z-50 flex items-center gap-1 rounded-full border border-line-2 bg-card/95 py-1 pl-3.5 pr-1 shadow-[0_8px_30px_-12px_rgba(24,24,24,.25)] backdrop-blur-md"
    >
      <span className="font-mono text-xs text-grey">⌕</span>
      <input
        ref={input}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
          else if (e.key === "g" && e.metaKey) {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
        }}
        placeholder="find on page"
        spellCheck={false}
        className="w-48 bg-transparent px-1.5 py-1 text-[13px] text-ink outline-none placeholder:text-grey"
      />
      <span className="min-w-[3.25rem] text-right font-mono text-[11px] tabular-nums text-grey">
        {q ? (hits.length ? `${at + 1}/${hits.length}` : "none") : ""}
      </span>
      <button aria-label="previous match" onClick={() => step(-1)} className="grid h-7 w-7 place-items-center rounded-full text-ink-2 hover:bg-paper">
        ‹
      </button>
      <button aria-label="next match" onClick={() => step(1)} className="grid h-7 w-7 place-items-center rounded-full text-ink-2 hover:bg-paper">
        ›
      </button>
      <button aria-label="close find" onClick={onClose} className="grid h-7 w-7 place-items-center rounded-full text-grey hover:bg-paper hover:text-ink">
        ×
      </button>
    </motion.div>
  );
}
