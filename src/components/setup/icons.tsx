import { motion } from "motion/react";

// 16px line icons, one per checklist row. Unknown ids fall back to a dot.
const P: Record<string, string> = {
  claude: "M4 17l6-6-6-6M12 19h8", // terminal
  node: "M12 2l9 5v10l-9 5-9-5V7z", // hexagon
  chromium: "M12 2a10 10 0 100 20 10 10 0 000-20zM2 12h20M12 2a15 15 0 010 20M12 2a15 15 0 000 20", // globe
  repo: "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z", // folder
  keys: "M15 7a4 4 0 11-3.9 4.9L3 20v-3h3v-3h3l1.1-1.1A4 4 0 0115 7z", // key
  appUrl: "M10 14a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 10a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1", // link
  migrations: "M12 2l10 5-10 5L2 7zM2 12l10 5 10-5M2 17l10 5 10-5", // layers
  hosts: "M3 5h18v6H3zM3 13h18v6H3zM7 8h.01M7 16h.01", // server
  lambdamd: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M8 13h8M8 17h5", // file
};
const ALIAS: Record<string, string> = {
  frontendUrl: "appUrl", url: "appUrl", app: "appUrl", envPath: "keys", env: "keys", playwright: "chromium",
  migrationsDir: "migrations", appHosts: "hosts", lambda: "lambdamd", "lambda.md": "lambdamd", repoPath: "repo",
};

export function RowIcon({ id }: { id: string }) {
  const d = P[id] ?? P[ALIAS[id] ?? ""];
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {d ? <path d={d} /> : <circle cx="12" cy="12" r="3" />}
    </svg>
  );
}

// Status mark: a check that draws itself in, a hollow ring for missing, an amber dot for warn.
export function Mark({ state, still }: { state: "ok" | "warn" | "missing" | "pending"; still?: boolean }) {
  if (state === "pending")
    return <span className="block h-5 w-5 rounded-full border border-dashed border-line-2 motion-safe:animate-spin [animation-duration:2.4s]" aria-label="checking" />;
  if (state === "missing") return <span className="block h-5 w-5 rounded-full border-[1.5px] border-grey/60" aria-label="missing" />;
  if (state === "warn")
    return (
      <span className="grid h-5 w-5 place-items-center rounded-full bg-warn/15" aria-label="needs a look">
        <span className="h-1.5 w-1.5 rounded-full bg-warn" />
      </span>
    );
  return (
    <motion.span
      className="grid h-5 w-5 place-items-center rounded-full bg-ink text-paper"
      initial={still ? false : { scale: 0.6, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 520, damping: 26 }}
      aria-label="ok"
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <motion.path
          d="M5 12.5l4.5 4.5L19 7.5"
          initial={still ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.28, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
        />
      </svg>
    </motion.span>
  );
}
