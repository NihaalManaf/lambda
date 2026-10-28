"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import { Icon } from "@/components/viz/icons";

// One line: describe the change → send. Two icon buttons: paste/drop a .sql, or pick changed files from the repo.

export type ProposalBody =
  { source: "llm"; prompt: string } | { source: "sql"; sql: string; name?: string } | { source: "git"; files: string[] };
type GitFile = { file: string; status: string };

const pop = {
  initial: { opacity: 0, y: -4, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -4, scale: 0.98 },
};
const popT = { type: "spring", stiffness: 520, damping: 38 } as const;

export default function ProposalComposer({ busy, onSend }: { busy: boolean; onSend: (b: ProposalBody) => void }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState<"sql" | "git" | null>(null);
  const [sql, setSql] = useState("");
  const [git, setGit] = useState<GitFile[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [drop, setDrop] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const send = () => {
    if (busy || !text.trim()) return;
    onSend({ source: "llm", prompt: text.trim() });
    setText("");
  };
  const readFile = async (f: File | undefined) => {
    if (!f) return;
    onSend({ source: "sql", sql: await f.text(), name: f.name });
    setOpen(null);
  };
  const toggle = (k: "sql" | "git") => {
    setOpen((o) => (o === k ? null : k));
    if (k === "git") {
      setGit(null);
      setPicked([]);
      fetch("/api/schema/git")
        .then((r) => r.json())
        .then((b: { files?: GitFile[] }) => setGit(b.files ?? []))
        .catch(() => setGit([]));
    }
  };

  return (
    <div
      className="relative"
      onDragOver={(e) => {
        e.preventDefault();
        setDrop(true);
      }}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrop(false);
        readFile(e.dataTransfer.files[0]);
      }}
    >
      <div
        className={clsx(
          "flex items-center gap-1.5 rounded-full border bg-card py-1 pl-4 pr-1 transition-[border-color,box-shadow] duration-150 focus-within:border-ink focus-within:shadow-[0_0_0_3px_rgba(231,163,255,0.45)]",
          drop ? "border-ink shadow-[0_0_0_3px_rgba(231,163,255,0.45)]" : "border-line-2",
        )}
      >
        <input
          className="h-8 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-grey"
          placeholder={drop ? "drop .sql" : "describe the change"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <IconBtn on={open === "sql"} title="paste sql" onClick={() => toggle("sql")} icon="file" />
        <IconBtn on={open === "git"} title="from repo" onClick={() => toggle("git")} icon="split" />
        <button className="btn btn-primary !px-3.5 !py-1.5" disabled={busy || !text.trim()} onClick={send} title="draft">
          {busy ? (
            <span className="size-3 animate-spin rounded-full border-2 border-paper/40 border-t-paper" />
          ) : (
            <span aria-hidden>→</span>
          )}
        </button>
      </div>

      <AnimatePresence>
        {open && <motion.div key="veil" className="fixed inset-0 z-20" onClick={() => setOpen(null)} />}
        {open === "sql" && (
          <motion.div
            key="sql"
            {...pop}
            transition={popT}
            className="card absolute right-0 top-full z-30 mt-2 w-full max-w-md origin-top-right p-3 shadow-[2px_3px_0_var(--line-2)]"
          >
            <textarea
              autoFocus
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              placeholder="paste sql"
              rows={6}
              className="input resize-none font-mono !text-[12px]"
            />
            <div className="mt-2 flex items-center gap-2">
              <button type="button" className="btn btn-ghost !px-3 !py-1 text-[12px]" onClick={() => fileRef.current?.click()}>
                <Icon name="file" size={12} /> .sql
              </button>
              <input ref={fileRef} type="file" accept=".sql,text/plain" hidden onChange={(e) => readFile(e.target.files?.[0])} />
              <button
                type="button"
                className="btn btn-primary ml-auto !px-3.5 !py-1 text-[12px]"
                disabled={!sql.trim() || busy}
                onClick={() => {
                  onSend({ source: "sql", sql });
                  setSql("");
                  setOpen(null);
                }}
              >
                draw →
              </button>
            </div>
          </motion.div>
        )}
        {open === "git" && (
          <motion.div
            key="git"
            {...pop}
            transition={popT}
            className="card absolute right-0 top-full z-30 mt-2 w-full max-w-md origin-top-right p-2 shadow-[2px_3px_0_var(--line-2)]"
          >
            {git === null ? (
              <div className="space-y-1.5 p-1">
                {[0, 1].map((i) => (
                  <div key={i} className="shimmer h-5 rounded-md" />
                ))}
              </div>
            ) : git.length === 0 ? (
              <div className="p-3 text-center font-hand text-[15px] text-grey">no changed .sql</div>
            ) : (
              <>
                <ul className="max-h-60 overflow-auto">
                  {git.map((g) => {
                    const on = picked.includes(g.file);
                    return (
                      <li key={g.file}>
                        <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 hover:bg-paper-2">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => setPicked((p) => (on ? p.filter((x) => x !== g.file) : [...p, g.file]))}
                            className="accent-[var(--ink)]"
                          />
                          <span className={clsx("w-5 font-mono text-[10px]", /\?|A/.test(g.status) ? "text-ok" : "text-warn")}>
                            {g.status.trim() || "M"}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={g.file}>
                            {g.file.split("/").pop()}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-1 flex justify-end p-1">
                  <button
                    type="button"
                    className="btn btn-primary !px-3.5 !py-1 text-[12px]"
                    disabled={!picked.length || busy}
                    onClick={() => {
                      onSend({ source: "git", files: picked });
                      setOpen(null);
                    }}
                  >
                    draw {picked.length || ""} →
                  </button>
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function IconBtn({ on, title, onClick, icon }: { on: boolean; title: string; onClick: () => void; icon: "file" | "split" }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={clsx(
        "relative z-30 grid size-8 place-items-center rounded-full transition-colors duration-150",
        on ? "bg-ink text-paper" : "text-grey hover:bg-paper-2 hover:text-ink",
      )}
    >
      <Icon name={icon} size={15} />
    </button>
  );
}
