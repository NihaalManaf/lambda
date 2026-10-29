"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

type Doc = { text: string; isDefault: boolean; repo: { path: string; text: string } | null };

// settings → lambda.md: standing instructions every agent lambda runs reads first. Autosaves.
export default function LambdaMd({ initial }: { initial: Doc }) {
  const [doc, setDoc] = useState(initial);
  const [text, setText] = useState(initial.text);
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const put = async (body: { text: string | null }) => {
    const res = await fetch("/api/lambda-md", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return;
    const next = (await res.json()) as Doc;
    setDoc(next);
    if (body.text === null) setText(next.text);
    setSaved(true);
    setTimeout(() => setSaved(false), 1400);
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  const change = (v: string) => {
    setText(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => put({ text: v }), 600);
  };

  return (
    <section className="mt-12 grid gap-6 border-t border-line pt-8 md:grid-cols-[220px_1fr]">
      <div>
        <div className="eyebrow">05 · lambda.md</div>
        <h2 className="display mt-2 text-3xl">how we build</h2>
        <div className="mt-3 text-[13px] text-grey">read first by every agent: intake, chat, generation</div>
      </div>
      <div>
        <div className="mb-2 flex items-center gap-2">
          <span className="chip font-mono text-[11px]">{doc.isDefault ? "default" : "yours"}</span>
          {doc.repo && (
            <span className="chip font-mono text-[11px]" title={doc.repo.path}>
              + repo lambda.md
            </span>
          )}
          <AnimatePresence>
            {saved && (
              <motion.span initial={{ opacity: 0, y: 2 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="font-mono text-[11px] text-ok">
                saved ✓
              </motion.span>
            )}
          </AnimatePresence>
          <span className="flex-1" />
          {!doc.isDefault && (
            <button className="btn btn-ghost !px-3 !py-1 text-[12px]" onClick={() => put({ text: null })}>
              reset to default
            </button>
          )}
        </div>
        <textarea
          className="input min-h-[420px] resize-y font-mono text-[13px] leading-relaxed"
          spellCheck={false}
          value={text}
          onChange={(e) => change(e.target.value)}
        />
        {doc.repo && (
          <details className="mt-3">
            <summary className="cursor-pointer font-mono text-[11px] text-grey">repo lambda.md · also applied, after yours</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-paper-2 p-3 font-mono text-[12px] text-ink-2">{doc.repo.text}</pre>
          </details>
        )}
      </div>
    </section>
  );
}
