"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { Question, RepoOption } from "./api";
import { ago } from "@/components/home/time";

export type Answer = Record<string, unknown> | null; // null = skipped

// One question, big and alone. Enter confirms (the form submits), Esc skips when optional.
export function QuestionCard({
  q,
  step,
  total,
  busy,
  onAnswer,
}: {
  q: Question;
  step: number;
  total: number;
  busy: boolean;
  onAnswer: (a: Answer) => void;
}) {
  const still = useReducedMotion() ?? false;
  useEffect(() => {
    if (!q.optional) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onAnswer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [q.optional, busy, onAnswer]);

  return (
    <motion.section
      initial={still ? { opacity: 0 } : { opacity: 0, y: 14, filter: "blur(4px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      exit={still ? { opacity: 0 } : { opacity: 0, y: -8, filter: "blur(4px)", transition: { duration: 0.14 } }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className="card relative px-5 py-6 sm:px-8 sm:py-8"
      aria-label="setup question"
    >
      <div className="mb-4 flex items-center justify-between">
        <span className="eyebrow">
          question {step} of {total}
        </span>
        {q.optional && q.kind !== "account" ? (
          <button type="button" onClick={() => onAnswer(null)} disabled={busy} className="text-[12px] text-grey transition-colors hover:text-ink">
            skip <kbd className="ml-1 rounded border border-line-2 px-1 font-mono text-[10px]">esc</kbd>
          </button>
        ) : null}
      </div>
      {q.kind === "choice" ? <RepoQ q={q} busy={busy} onAnswer={onAnswer} /> : null}
      {q.kind === "secret" ? <SecretQ busy={busy} onAnswer={onAnswer} /> : null}
      {q.kind === "account" ? <LoginQ q={q} busy={busy} onAnswer={onAnswer} /> : null}
      {q.kind === "url" ? <UrlQ q={q} busy={busy} onAnswer={onAnswer} /> : null}
    </motion.section>
  );
}

const Title = ({ children }: { children: React.ReactNode }) => <h2 className="display text-[2rem] leading-[1.05] sm:text-[2.6rem]">{children}</h2>;

// `busy` = a request is in flight ("checking…"); `off` = not answerable yet (keeps its label)
const Enter = ({ busy, off = false, label = "continue" }: { busy: boolean; off?: boolean; label?: string }) => (
  <button className="btn btn-primary" disabled={busy || off}>
    {busy ? "checking…" : label}
    <kbd className="rounded border border-paper/30 px-1 font-mono text-[10px] font-normal opacity-70">↵</kbd>
  </button>
);

const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

function RepoQ({ q, busy, onAnswer }: { q: Extract<Question, { kind: "choice" }>; busy: boolean; onAnswer: (a: Answer) => void }) {
  const [pick, setPick] = useState<string>(q.default ?? q.options[0]?.path ?? "");
  const [other, setOther] = useState(q.options.length === 0);
  const [typed, setTyped] = useState("");
  const path = other ? typed.trim() : pick;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (path) onAnswer({ path });
      }}
    >
      <Title>
        which app are we <em>building?</em>
      </Title>
      <div role="radiogroup" className="mt-6 grid gap-2 sm:grid-cols-2">
        {q.options.slice(0, 6).map((r, i) => (
          <RepoCard
            key={r.path}
            r={r}
            on={!other && pick === r.path}
            first={i === 0}
            onPick={() => (setOther(false), setPick(r.path))}
            onConfirm={() => !busy && onAnswer({ path: r.path })}
          />
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={other}
          onClick={() => setOther(true)}
          className={`rounded-2xl border px-4 py-3 text-left outline-none transition-[border-color,background-color,transform] duration-150 focus-visible:ring-4 focus-visible:ring-lilac/50 active:scale-[0.98] ${other ? "border-ink bg-paper-2" : "border-line hover:border-line-2"}`}
        >
          <span className="text-[14px] font-semibold">somewhere else</span>
          <span className="mt-0.5 block text-[12px] text-grey">type a path</span>
        </button>
      </div>
      {other ? (
        <input
          autoFocus
          className="input mt-3 font-mono text-[13px]"
          placeholder="/Users/you/code/my-app"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          spellCheck={false}
        />
      ) : null}
      <div className="mt-6 flex justify-end">
        <Enter busy={busy} off={!path} label="use this repo" />
      </div>
    </form>
  );
}

// Enter on a focused card confirms it (a type=button would otherwise just re-pick)
function RepoCard({ r, on, first, onPick, onConfirm }: { r: RepoOption; on: boolean; first: boolean; onPick: () => void; onConfirm: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      autoFocus={first}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        onConfirm();
      }}
      className={`min-w-0 rounded-2xl border px-4 py-3 text-left outline-none transition-[border-color,background-color,transform] duration-150 focus-visible:ring-4 focus-visible:ring-lilac/50 active:scale-[0.98] ${on ? "border-ink bg-paper-2" : "border-line hover:border-line-2"}`}
    >
      <span className="flex items-baseline gap-2">
        <span className="display truncate text-[20px]">{r.name}</span>
        {on ? <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-lilac" /> : null}
      </span>
      <span className="mt-0.5 block truncate font-mono text-[11px] text-grey">{tilde(r.path)}</span>
      <span className="mt-1.5 block truncate text-[12px] text-ink-2">
        {r.sessions} session{r.sessions === 1 ? "" : "s"}
        {r.lastUsed ? ` · ${ago(r.lastUsed)}` : r.branch ? ` · ${r.branch}` : ""}
      </span>
    </button>
  );
}

function SecretQ({ busy, onAnswer }: { busy: boolean; onAnswer: (a: Answer) => void }) {
  const [v, setV] = useState("");
  const looksOk = /^sk-ant-[\w-]{20,300}$/.test(v.trim());
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (looksOk) onAnswer({ anthropicKey: v.trim() });
      }}
    >
      <Title>
        paste your <em>anthropic</em> key
      </Title>
      <input
        autoFocus
        type="password"
        autoComplete="off"
        className="input mt-6 font-mono"
        placeholder="sk-ant-…"
        value={v}
        onChange={(e) => setV(e.target.value)}
        aria-label="anthropic api key"
      />
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-grey">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 018 0v4" />
          </svg>
          stored locally · 0600
        </span>
        <Enter busy={busy} off={!looksOk} label="save key" />
      </div>
    </form>
  );
}

function LoginQ({ q, busy, onAnswer }: { q: Extract<Question, { kind: "account" }>; busy: boolean; onAnswer: (a: Answer) => void }) {
  const found = q.candidates.find((c) => c.id === q.prefill.candidateId) ?? null;
  // a CI bot (…+ci@momentic) is real but rarely the login you browse as: offer it, don't default to it
  const [diff, setDiff] = useState(!found || found.bot);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [loginUrl, setLoginUrl] = useState(q.prefill.loginUrl || "/login");
  const emailRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (diff) emailRef.current?.focus();
  }, [diff]);
  const url = loginUrl.trim() || "/login";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!diff && found) onAnswer({ accountCandidateId: found.id, account: { loginUrl: url } });
        else if (email.trim() && pw) onAnswer({ account: { label: "test account", loginUrl: url, email: email.trim(), password: pw } });
      }}
    >
      <Title>
        a <em>test login</em> for your app?
      </Title>
      {!diff && found ? (
        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-paper-2 px-4 py-3">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-lilac-soft font-mono text-[13px]">{found.email[0] ?? "@"}</span>
          <span className="min-w-0">
            <span className="block truncate font-mono text-[13px]">{found.email}</span>
            <span className="block truncate text-[11px] text-grey">
              {found.bot ? "your ci login · " : ""}from {found.from}
            </span>
          </span>
        </div>
      ) : (
        <>
          {found?.bot ? (
            <p className="mt-4 text-[13px] text-ink-2">
              only found <span className="font-mono">{found.email}</span> — a ci login. yours?
            </p>
          ) : null}
          <div className="mt-6 grid gap-2 sm:grid-cols-2">
            <input
              ref={emailRef}
              className="input"
              type="email"
              placeholder="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-label="test login email"
            />
            <input className="input" type="password" placeholder="password" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} aria-label="test login password" />
          </div>
        </>
      )}
      {/* where lambda types it: visible + editable, never a silent guess */}
      <label className="mt-3 flex items-center gap-2 text-[12px] text-grey">
        <span className="shrink-0">signs in at</span>
        <input
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 font-mono text-[12px] text-ink-2 outline-none transition-colors hover:border-line focus:border-line-2 focus:bg-paper"
          value={loginUrl}
          onChange={(e) => setLoginUrl(e.target.value)}
          spellCheck={false}
          aria-label="login page path"
        />
        <span className="shrink-0 truncate font-mono text-[11px]">{found?.loginUrlSource ? `found · ${found.loginUrlSource.split("/").slice(-2).join("/")}` : "guess"}</span>
      </label>
      <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
        {found ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setDiff((d) => !d)}
            disabled={busy}
          >
            {diff ? (found.bot ? "use the ci login" : "use found login") : "different"}
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost" onClick={() => onAnswer(null)} disabled={busy}>
          skip
        </button>
        <Enter busy={busy} off={diff && !(email.trim() && pw)} label={diff ? "save login" : "use this"} />
      </div>
    </form>
  );
}

function UrlQ({ q, busy, onAnswer }: { q: Extract<Question, { kind: "url" }>; busy: boolean; onAnswer: (a: Answer) => void }) {
  const [v, setV] = useState(q.default || "http://localhost:3000");
  const valid = /^https?:\/\/[^\s]+$/.test(v.trim());
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onAnswer({ frontendUrl: v.trim() });
      }}
    >
      <Title>
        where does your app <em>run?</em>
      </Title>
      <input autoFocus className="input mt-6 font-mono" inputMode="url" spellCheck={false} value={v} onChange={(e) => setV(e.target.value)} />
      <div className="mt-6 flex justify-end">
        <Enter busy={busy} off={!valid} />
      </div>
    </form>
  );
}
