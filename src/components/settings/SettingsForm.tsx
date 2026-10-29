"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { MaskedAccount, SettingsView } from "./types";
import { MODELS } from "./types";

type SaveState = "idle" | "saving" | "saved" | "error";

const spring = { type: "spring", stiffness: 420, damping: 34 } as const;
const newId = () => `acct_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;

export default function SettingsForm({ initial }: { initial: SettingsView }) {
  const [s, setS] = useState(initial);
  const [save, setSave] = useState<SaveState>("idle");
  const [badBase, setBadBase] = useState(false); // the server refused the base branch (not a valid ref)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Autosave: debounce, PUT, then merge only server-owned bits (key dots, hasPassword) back in.
  function change(next: SettingsView) {
    setS(next);
    setSave("saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const { keys: _k, ...body } = next;
        void _k;
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error();
        const v = (await res.json()) as SettingsView;
        // an invalid ref is dropped server-side, never saved: say so instead of a green "saved"
        const rejected = (next.baseBranch ?? "").trim() !== (v.baseBranch ?? "");
        setBadBase(rejected);
        setS((cur) => ({
          ...cur,
          keys: v.keys,
          accounts: cur.accounts.map((a) => ({
            ...a,
            hasPassword: v.accounts.find((x) => x.id === a.id)?.hasPassword ?? a.hasPassword,
          })),
        }));
        if (rejected) return setSave("error");
        setSave("saved");
        setTimeout(() => setSave((x) => (x === "saved" ? "idle" : x)), 1600);
      } catch {
        setSave("error");
      }
    }, 600);
  }

  const set = <K extends keyof SettingsView>(k: K, v: SettingsView[K]) => change({ ...s, [k]: v });
  const setAcct = (id: string, patch: Partial<MaskedAccount>) =>
    set("accounts", s.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)));

  return (
    <div className="mt-12 space-y-14">
      <SavePill state={save} />

      <Section eyebrow="01 · keys" title="bring your own keys" aside="read from your webapp .env — values never shown">
        <Field label="env file">
          <input className="input font-mono" value={s.envPath} onChange={(e) => set("envPath", e.target.value)} />
        </Field>
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {Object.entries(s.keys).map(([name, ok]) => (
            <div key={name} className="card flex items-center gap-3 px-4 py-3">
              <motion.span
                className="h-2.5 w-2.5 rounded-full"
                animate={{ backgroundColor: ok ? "var(--ok)" : "var(--line-2)", scale: ok ? [1, 1.35, 1] : 1 }}
                transition={{ duration: 0.4 }}
              />
              <span className="font-mono text-[12px] text-ink-2">{name}</span>
              <span className={`ml-auto text-[12px] ${ok ? "text-ok" : "text-grey"}`}>{ok ? "found" : "missing"}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section eyebrow="02 · your app" title="the thing we test" aside="where agents look and click">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="frontend url">
            <input className="input font-mono" value={s.frontendUrl} onChange={(e) => set("frontendUrl", e.target.value)} />
          </Field>
          <Field label="repo path">
            <input className="input font-mono" value={s.repoPath} onChange={(e) => set("repoPath", e.target.value)} />
          </Field>
        </div>
        <Field label="base branch" className="mt-4">
          <input
            className="input font-mono"
            placeholder="auto · main / master"
            value={s.baseBranch ?? ""}
            onChange={(e) => set("baseBranch", e.target.value)}
          />
        </Field>
        {badBase ? (
          <p className="mt-2 font-mono text-[11px] text-bad">not a valid branch name — not saved</p>
        ) : (
          <p className="mt-2 font-mono text-[11px] text-grey">branch lambda reads from, e.g. origin/staging · remote refs fetched first · empty = auto</p>
        )}
        <Field label="model" className="mt-4">
          <div className="inline-flex rounded-full border border-line-2 bg-card p-1">
            {MODELS.map((m) => (
              <button
                key={m}
                onClick={() => set("model", m)}
                className={`relative rounded-full px-3.5 py-1.5 font-mono text-[12px] transition-colors ${s.model === m ? "text-paper" : "text-ink-2 hover:text-ink"}`}
              >
                {s.model === m && (
                  <motion.span layoutId="model-pill" className="absolute inset-0 rounded-full bg-ink" transition={spring} />
                )}
                <span className="relative">{m.replace("claude-", "")}</span>
              </button>
            ))}
          </div>
        </Field>
        <Field label="edge cases" className="mt-4">
          <div className="inline-flex rounded-full border border-line-2 bg-card p-1">
            {([true, false] as const).map((on) => (
              <button
                key={String(on)}
                onClick={() => set("edgeCases", on)}
                className={`relative rounded-full px-3.5 py-1.5 font-mono text-[12px] transition-colors ${(s.edgeCases !== false) === on ? "text-paper" : "text-ink-2 hover:text-ink"}`}
              >
                {(s.edgeCases !== false) === on && (
                  <motion.span layoutId="edge-pill" className="absolute inset-0 rounded-full bg-ink" transition={spring} />
                )}
                <span className="relative">{on ? "on" : "off"}</span>
              </button>
            ))}
          </div>
        </Field>
        <p className="mt-2 font-mono text-[11px] text-grey">unhappy paths pinned to flowchart nodes · off = not drawn, hidden on existing charts</p>
      </Section>

      <Section eyebrow="03 · schema + queues" title="where tables + queues come from" aside="migrations replayed in order">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="migrations dir">
            <input className="input font-mono" value={s.migrationsDir} onChange={(e) => set("migrationsDir", e.target.value)} />
          </Field>
          <Field label="extra dirs">
            <ListInput value={s.extraMigrationDirs} onChange={(v) => set("extraMigrationDirs", v)} />
          </Field>
        </div>
        <Field label="baseline dump" className="mt-4">
          <input
            className="input font-mono"
            placeholder="optional · schema.sql"
            value={s.baselineSchemaPath}
            onChange={(e) => set("baselineSchemaPath", e.target.value)}
          />
        </Field>
        <p className="mt-2 font-mono text-[11px] text-grey">pg_dump --schema-only --no-owner -n public &gt; schema.sql</p>
        <Field label="your api hosts" className="mt-4">
          <ListInput value={s.appHosts ?? []} onChange={(v) => set("appHosts", v)} />
        </Field>
        <p className="mt-2 font-mono text-[11px] text-grey">queue urls on these hosts count as yours · e.g. myapp</p>
      </Section>

      <Section
        eyebrow="04 · test accounts"
        title="who the browser logs in as"
        aside={<span className="chip font-mono text-[11px]">stored locally · 0600</span>}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <AnimatePresence initial={false}>
            {s.accounts.map((a) => (
              <motion.div
                key={a.id}
                layout
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={spring}
              >
                <AccountCard a={a} onPatch={(p) => setAcct(a.id, p)} onRemove={() => set("accounts", s.accounts.filter((x) => x.id !== a.id))} />
              </motion.div>
            ))}
            <motion.button
              key="add"
              layout
              transition={spring}
              onClick={() =>
                set("accounts", [
                  ...s.accounts,
                  { id: newId(), label: "", loginUrl: "/login", email: "", password: "", hasPassword: false },
                ])
              }
              className="flex min-h-[180px] flex-col items-center justify-center gap-2 rounded-[18px] border border-dashed border-line-2 text-grey transition-colors hover:border-ink hover:text-ink"
            >
              <span className="display text-4xl">+</span>
              <span className="text-sm">add account</span>
            </motion.button>
          </AnimatePresence>
        </div>
      </Section>
    </div>
  );
}

function AccountCard({
  a,
  onPatch,
  onRemove,
}: {
  a: MaskedAccount;
  onPatch: (p: Partial<MaskedAccount>) => void;
  onRemove: () => void;
}) {
  const [reveal, setReveal] = useState(false);
  return (
    <div className="card space-y-2.5 p-4">
      <div className="flex items-center gap-2">
        <input
          className="display w-full bg-transparent text-2xl outline-none placeholder:text-line-2"
          placeholder="admin, free user…"
          value={a.label}
          onChange={(e) => onPatch({ label: e.target.value })}
        />
        <button onClick={onRemove} aria-label="remove account" className="text-grey transition-colors hover:text-bad">
          ×
        </button>
      </div>
      <input className="input font-mono text-[13px]" placeholder="login url" value={a.loginUrl} onChange={(e) => onPatch({ loginUrl: e.target.value })} />
      <input className="input text-[13px]" placeholder="email" autoComplete="off" value={a.email} onChange={(e) => onPatch({ email: e.target.value })} />
      <div className="relative">
        <input
          className="input pr-16 text-[13px]"
          type={reveal ? "text" : "password"}
          autoComplete="new-password"
          placeholder={a.hasPassword ? "•••••••• kept" : "password"}
          value={a.password}
          onChange={(e) => onPatch({ password: e.target.value })}
        />
        <button
          onClick={() => setReveal((r) => !r)}
          className="eyebrow absolute right-3 top-1/2 -translate-y-1/2 hover:text-ink"
        >
          {reveal ? "hide" : "show"}
        </button>
      </div>
      <input className="input text-[13px]" placeholder="notes (2fa, seed data…)" value={a.notes ?? ""} onChange={(e) => onPatch({ notes: e.target.value })} />
    </div>
  );
}

// comma-separated list; keeps its own text so a trailing ", " survives while typing
function ListInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(", "));
  return (
    <input
      className="input font-mono"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split(",").map((x) => x.trim()).filter(Boolean));
      }}
    />
  );
}

function Section({
  eyebrow,
  title,
  aside,
  children,
}: {
  eyebrow: string;
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-6 border-t border-line pt-8 md:grid-cols-[220px_1fr]">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h2 className="display mt-2 text-3xl">{title}</h2>
        {aside && <div className="mt-3 text-[13px] text-grey">{aside}</div>}
      </div>
      <div>{children}</div>
    </section>
  );
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="eyebrow mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}

function SavePill({ state }: { state: SaveState }) {
  return (
    <div className="pointer-events-none fixed right-6 top-[68px] z-30">
      <AnimatePresence mode="wait">
        {state !== "idle" && (
          <motion.div
            key={state}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
            className={`chip ${state === "error" ? "border-bad text-bad" : state === "saved" ? "text-ok" : "text-grey"}`}
          >
            {state === "saving" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-grey" />}
            {state === "saved" && (
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                <motion.path
                  d="M2 6.5 L5 9 L10 3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.3 }}
                />
              </svg>
            )}
            {state === "saving" ? "saving" : state === "saved" ? "saved" : "save failed"}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
