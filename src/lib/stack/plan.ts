import { z } from "zod";
import type { StackPlan, StackService } from "../types";

// The stack plan: how to run the app locally (pure — no fs, no processes). Written by a Claude Code session
// (src/lib/stack/planner.ts) as a fenced ```lambda-stack block, validated here, approved by the developer.

// the developer's own servers usually sit here; lambda's stack never binds or points at them
export const RESERVED_PORTS = [3000, 3001, 4900, 5173, 6969, 8000, 8080, 8081];

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// a port flag: `--port`, `-p`, `-port=` (with `=` it's glued to the number: `-port=5001`)
export const PORT_ARG = /^--?[A-Za-z][\w-]*=?$/;

// env keys that change how a loader / shell / runtime behaves — a plan setting one could run code the
// developer never sees in the commands. Rejected in plans and dropped at spawn time.
export const LOADER_ENV =
  /^(NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE|DYLD_.*|LD_.*|PYTHON(?!UNBUFFERED$|DONTWRITEBYTECODE$|IOENCODING$).*|PATH|HOME|SHELL|BASH_ENV|ENV|ZDOTDIR|PROMPT_COMMAND|PS4|IFS|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|GIT_.*|ELECTRON_RUN_AS_NODE|npm_config_.*|NPM_CONFIG_.*|YARN_.*|BUN_.*|UV_.*|PIP_.*|VIRTUAL_ENV|CONDA_.*)$/i;

// relative, inside the checkout: no absolute paths, no `..` segments
const relPath = z
  .string()
  .trim()
  .max(300)
  .refine((p) => !p.startsWith("/") && !p.startsWith("~") && !p.split(/[\\/]/).includes(".."), "must be a relative path inside the repo");

const cmd = z.union([z.array(z.string().max(2000)).min(1).max(64), z.string().min(1).max(2000)]);

const ServiceSchema = z.object({
  name: z.string().regex(NAME, "name: letters, digits, - and _ only"),
  cwd: relPath.default("."),
  cmd,
  shell: z.boolean().optional(),
  port: z.object({ env: z.string().regex(ENV_KEY).optional(), arg: z.string().max(40).regex(PORT_ARG, "port.arg: a flag like --port or -port=").optional() }).optional(),
  extraPorts: z.array(z.string().regex(NAME)).max(4).optional(),
  ready: z
    .object({
      path: z.string().max(300).optional(),
      status: z.number().int().min(100).max(599).optional(),
      log: z.string().max(300).optional(),
      timeoutSec: z.number().int().min(5).max(900).optional(),
    })
    .optional(),
  role: z.enum(["frontend", "api", "queue", "worker", "other"]),
  optional: z.boolean().optional(),
});

const SetupSchema = z.object({
  name: z.string().regex(NAME),
  cwd: relPath.default("."),
  cmd,
  shell: z.boolean().optional(),
  skipIf: relPath.optional(),
});

export const StackPlanSchema = z.object({
  services: z.array(ServiceSchema).min(1).max(8),
  setup: z.array(SetupSchema).max(8).default([]),
  env: z.record(z.string(), z.record(z.string().regex(ENV_KEY), z.string().max(4000))).default({}),
  envFiles: z.array(relPath).max(12).default([]),
  notes: z.array(z.string().max(400)).max(12).default([]),
});

const PLACEHOLDER = /\$\{([^}]*)\}/g;
const placeholders = (s: string) => [...s.matchAll(PLACEHOLDER)].map((m) => m[1]);
const cmdText = (c: string[] | string) => (Array.isArray(c) ? c : [c]);

// Semantic checks zod can't express. Returns issues (empty = fine).
export function planIssues(plan: StackPlan, reserved: number[] = RESERVED_PORTS): string[] {
  const issues: string[] = [];
  const names = new Map<string, StackService>();
  for (const s of plan.services) {
    if (names.has(s.name)) issues.push(`duplicate service "${s.name}"`);
    names.set(s.name, s);
  }
  const setupNames = new Set<string>();
  for (const s of plan.setup) {
    if (setupNames.has(s.name)) issues.push(`duplicate setup step "${s.name}"`);
    setupNames.add(s.name);
  }
  const shellCheck = (label: string, x: { cmd: string[] | string; shell?: boolean }) => {
    if (typeof x.cmd === "string" && !x.shell) issues.push(`${label}: a string cmd needs "shell": true (or use an argv array)`);
    if (Array.isArray(x.cmd) && x.shell) issues.push(`${label}: "shell": true needs cmd as one string`);
  };
  const res = reserved.join("|");
  const literalPort = new RegExp(`(?:--?port[= ]|-p[= ]?|-port=|localhost:|127\\.0\\.0\\.1:|\\[::1\\]:|0\\.0\\.0\\.0:)(${res})\\b`, "i");
  const refCheck = (label: string, text: string, self?: StackService) => {
    for (const p of placeholders(text)) {
      const err = checkPlaceholder(p, names, self);
      if (err) issues.push(`${label}: \${${p}} ${err}`);
    }
    const m = text.match(literalPort);
    if (m) issues.push(`${label}: hard-coded port ${m[1]} — the developer's own servers use it; use \${port} / \${url:<service>}`);
  };
  for (const s of plan.services) {
    shellCheck(`service ${s.name}`, s);
    refCheck(`service ${s.name}`, cmdText(s.cmd).join(" "), s); // joined: catches ["--port", "8000"]
    if (s.ready?.log) {
      try {
        new RegExp(s.ready.log);
      } catch {
        issues.push(`service ${s.name}: ready.log is not a valid regex`);
      }
    }
    if (s.ready?.path && !s.ready.path.startsWith("/")) issues.push(`service ${s.name}: ready.path must start with /`);
    if (s.ready?.path && !s.port) issues.push(`service ${s.name}: ready.path needs a port`);
    if (s.port?.env && LOADER_ENV.test(s.port.env)) issues.push(`service ${s.name}: port.env ${s.port.env} changes how programs load — not allowed`);
  }
  for (const s of plan.setup) {
    shellCheck(`setup ${s.name}`, s);
    refCheck(`setup ${s.name}`, cmdText(s.cmd).join(" "));
  }
  for (const [svc, vars] of Object.entries(plan.env)) {
    const self = names.get(svc);
    if (!self) issues.push(`env: unknown service "${svc}"`);
    for (const [k, v] of Object.entries(vars)) {
      if (LOADER_ENV.test(k)) issues.push(`env ${svc}.${k}: changes how programs load or which shell runs — not allowed in a plan`);
      refCheck(`env ${svc}.${k}`, v, self);
      if (/^(PORT|.*_PORT)$/.test(k) && reserved.includes(Number(v))) issues.push(`env ${svc}.${k}: hard-coded port ${v}`);
    }
  }
  return issues;
}

// Things a valid plan may do that the developer should look at twice before approving (shown loudly on the
// approval sheet, never silently accepted): executables outside the checkouts, network fetchers, inline
// interpreters, and services that listen beyond loopback.
export function planWarnings(plan: StackPlan): string[] {
  const out: string[] = [];
  const steps = [...plan.services.map((s) => ({ label: `service ${s.name}`, x: s })), ...plan.setup.map((s) => ({ label: `setup ${s.name}`, x: s }))];
  for (const { label, x } of steps) {
    const argv = cmdText(x.cmd);
    const exe = Array.isArray(x.cmd) ? x.cmd[0] : (x.cmd.trim().split(/\s+/)[0] ?? "");
    if (exe.startsWith("/") || exe.startsWith("~")) out.push(`${label} runs ${exe}, outside your repo`);
    const text = argv.join(" ");
    if (/(^|[\s;&|(`])(curl|wget|nc|ncat|scp|ssh|ftp)(\s|$)/.test(text)) out.push(`${label} fetches from the network`);
    if (/(^|[\s;&|(`/])(sh|bash|zsh|dash|eval|osascript)(\s+-\w*c\b|\s|$)/.test(text) && !x.shell) out.push(`${label} starts a shell`);
    if (/\|\s*(sh|bash|zsh)\b/.test(text)) out.push(`${label} pipes into a shell`);
    if (/(^|[\s/])(python3?|node|ruby|perl|deno|bun)\s+(-c|-e|--eval|-p)\b/.test(text) || (Array.isArray(x.cmd) && /^(-c|-e|--eval)$/.test(x.cmd[1] ?? "") && /(python|node|ruby|perl)/.test(exe)))
      out.push(`${label} runs inline code`);
    if (/qstash-cli/.test(text)) out.push(`${label}: qstash-cli has no host flag — it listens on your network (all interfaces) while it runs`);
    else if (/(--host[= ](0\.0\.0\.0|::)|-H[= ]?(0\.0\.0\.0|::))(\s|$)/.test(text)) out.push(`${label} listens on every network interface, not just this mac`);
  }
  return [...new Set(out)];
}

function checkPlaceholder(p: string, names: Map<string, StackService>, self?: StackService): string | null {
  if (p === "repo" || p === "worktree") return null;
  const m = p.match(/^(port|url)(?:\.([\w-]+))?(?::([\w-]+)(?:\.([\w-]+))?)?$/);
  if (!m) return "is not a known placeholder";
  const [, kind, ownExtra, svcName, svcExtra] = m;
  if (ownExtra && svcName) return "is not a known placeholder";
  const target = svcName ? names.get(svcName) : self;
  if (!target) return svcName ? `refers to unknown service "${svcName}"` : "needs a service (only valid inside a service)";
  const extra = ownExtra ?? svcExtra;
  if (extra) {
    if (kind === "url") return "url takes no extra port";
    if (!target.extraPorts?.includes(extra)) return `service "${target.name}" has no extra port "${extra}"`;
  } else if (!target.port) return `service "${target.name}" has no port`;
  return null;
}

// a service gets a port when anything needs one: its own ${port}/${url}, an http ready path, or another
// service / env referring to it — so "port": {} needn't be spelled out
export function withImplicitPorts(plan: StackPlan): StackPlan {
  const texts = (svc: StackService) => [...cmdText(svc.cmd), ...Object.values(plan.env[svc.name] ?? {})];
  const all = [...plan.services.flatMap((x) => cmdText(x.cmd)), ...plan.setup.flatMap((x) => cmdText(x.cmd)), ...Object.values(plan.env).flatMap((e) => Object.values(e))];
  return {
    ...plan,
    services: plan.services.map((svc) => {
      if (svc.port) return svc;
      const own = texts(svc).some((t) => placeholders(t).some((p) => p === "port" || p === "url"));
      const ref = all.some((t) => placeholders(t).some((p) => p === `port:${svc.name}` || p === `url:${svc.name}`));
      return own || ref || svc.ready?.path ? { ...svc, port: {} } : svc;
    }),
  };
}

export type ParsedPlan = { plan: StackPlan } | { error: string };

export function validatePlan(raw: unknown, reserved?: number[]): ParsedPlan {
  const r = StackPlanSchema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "plan"}: ${i.message}`);
    return { error: first.join("; ") };
  }
  const plan = withImplicitPorts(r.data as StackPlan);
  const issues = planIssues(plan, reserved);
  return issues.length ? { error: issues.slice(0, 4).join("; ") } : { plan };
}

// the LAST valid ```lambda-stack block in the text wins (a session may correct itself)
export function parsePlanBlock(text: string, reserved?: number[]): ParsedPlan {
  const blocks = [...text.matchAll(/```lambda-stack[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (!blocks.length) return { error: "no lambda-stack block in the reply" };
  let last: ParsedPlan = { error: "no lambda-stack block" };
  for (const b of blocks.reverse()) {
    let json: unknown;
    try {
      json = JSON.parse(b);
    } catch (e) {
      last = { error: `lambda-stack block is not valid JSON (${e instanceof Error ? e.message.slice(0, 80) : "parse error"})` };
      continue;
    }
    last = validatePlan(json, reserved);
    if ("plan" in last) return last;
  }
  return last;
}

// ---------- placeholders ----------

export type PortMap = Record<string, { port?: number; extra?: Record<string, number> }>;
export type Vars = { repo: string; worktree: string; ports: PortMap; host?: string };

export const urlFor = (port: number, host = "localhost") => `http://${host}:${port}`;

// Resolves every ${...} in s. self = the service the text belongs to (for ${port} / ${url}). Throws on
// anything unresolvable — a plan that validated never does.
export function resolvePlaceholders(s: string, v: Vars, self?: string): string {
  return s.replace(PLACEHOLDER, (_, p: string) => {
    if (p === "repo") return v.repo;
    if (p === "worktree") return v.worktree;
    const m = p.match(/^(port|url)(?:\.([\w-]+))?(?::([\w-]+)(?:\.([\w-]+))?)?$/);
    if (!m) throw new Error(`unknown placeholder \${${p}}`);
    const [, kind, ownExtra, svcName, svcExtra] = m;
    const name = svcName ?? self;
    const entry = name ? v.ports[name] : undefined;
    if (!entry) throw new Error(`\${${p}}: no ports for ${name ?? "(no service)"}`);
    const extra = ownExtra ?? svcExtra;
    const port = extra ? entry.extra?.[extra] : entry.port;
    if (!port) throw new Error(`\${${p}}: no port allocated`);
    return kind === "url" ? urlFor(port, v.host) : String(port);
  });
}

// argv (or [shell, -lc, line]) for a service / setup step, with its port arg appended
export function commandFor(x: { cmd: string[] | string; shell?: boolean; port?: { arg?: string } }, v: Vars, self?: string, port?: number): { file: string; args: string[] } {
  // the arg is validated as a bare flag; refuse anything else even from an old stored plan
  const arg = x.port?.arg;
  if (arg && !PORT_ARG.test(arg)) throw new Error(`port.arg ${JSON.stringify(arg).slice(0, 40)} is not a flag`);
  const extra = arg && port ? (arg.endsWith("=") ? [`${arg}${port}`] : [arg, String(port)]) : [];
  if (typeof x.cmd === "string") {
    const line = [resolvePlaceholders(x.cmd, v, self), ...extra].join(" ");
    return { file: "/bin/zsh", args: ["-lc", line] };
  }
  const argv = [...x.cmd.map((a) => resolvePlaceholders(a, v, self)), ...extra];
  return { file: argv[0], args: argv.slice(1) };
}

// ---------- the planning prompt ----------

// Upstash's documented fixed credentials for `qstash-cli dev` (public, printed by the dev server itself)
export const QSTASH_DEV = {
  QSTASH_TOKEN: "eyJVc2VySUQiOiJkZWZhdWx0VXNlciIsIlBhc3N3b3JkIjoiZGVmYXVsdFBhc3N3b3JkIn0=",
  QSTASH_CURRENT_SIGNING_KEY: "sig_7kYjw48mhY7kAjqNGcy6cr29RJ6r",
  QSTASH_NEXT_SIGNING_KEY: "sig_5ZB6DVzB1wjE8S6rZ7eenA8Pdnhs",
};

export const STACK_PROMPT = `
you plan how lambda runs a private copy of this app on the developer's machine, so the app can be used in a browser. you only read files (Read, Grep, Glob). you never run anything, never write code, never call ExitPlanMode.

read first: AGENTS.md, CLAUDE.md, README*, every package.json, pyproject.toml / requirements*.txt, docker-compose*, Procfile, Makefile, .env.example files, framework configs. find how the frontend finds the api (e.g. NEXT_PUBLIC_API_URL) and how the api finds a queue (QSTASH_URL, …) and builds callback urls.

rules:
- the MINIMAL set of services to use the app in a browser: the frontend, the api it calls, and a local queue emulator only if api endpoints need one. skip admin apps, docs sites, storybook, background workers not needed for pages to load.
- every service gets its own free port from lambda. NEVER hard-code a port and never use the developer's usual ports (${RESERVED_PORTS.join(", ")}) — their own servers run there. use \${port} (this service's port) in cmd, or "port": {"env": "PORT"} (inject) / {"arg": "--port"} (append "--port <n>"). a second port a service binds goes in "extraPorts": ["log"] → \${port.log}.
- bind loopback when the tool has a host flag (next dev -H 127.0.0.1, uvicorn --host 127.0.0.1).
- wire services with placeholders, never literal urls: \${url:<service>} = http://localhost:<port>, \${port:<service>}. e.g. frontend env NEXT_PUBLIC_API_URL=\${url:api}. if the api builds absolute urls of itself or the frontend (callbacks, redirects, cors origins), set those env vars too.
- this checkout (\${worktree}) is a fresh git worktree: NO gitignored files (no node_modules, venv, .env). the developer's checkout is \${repo} and has them (listed below). reuse, don't reinstall:
  - python: run the developer's venv by absolute path, e.g. ["\${repo}/api/venv/bin/uvicorn", "app:app", "--host", "127.0.0.1", "--port", "\${port}"] — no activate needed.
  - node: a setup step cloning node_modules copy-on-write: {"name": "frontend-modules", "cwd": "frontend", "cmd": ["cp", "-cR", "\${repo}/frontend/node_modules", "node_modules"], "skipIf": "node_modules"} (a symlink breaks turbopack). only fall back to npm ci when the developer has none.
  - run binaries directly (node_modules/.bin/next dev …, or npx next dev …) rather than npm scripts that hard-code ports.
- envFiles: the gitignored env files the services read (relative to the repo root, e.g. "frontend/.env.local", "api/.env"). lambda copies them. NEVER put secret values in the plan — "env" holds only wiring (urls, ports, local dev credentials) and overrides the env files.
- local qstash (when needed): {"name": "qstash", "role": "queue", "cwd": ".", "cmd": ["npx", "--yes", "@upstash/qstash-cli@latest", "dev", "-port=\${port}", "-log-port=\${port.log}"], "extraPorts": ["log"], "ready": {"path": "/"}}. its fixed dev credentials (documented by upstash, safe to write): QSTASH_URL=\${url:qstash}, QSTASH_TOKEN=${QSTASH_DEV.QSTASH_TOKEN}, QSTASH_CURRENT_SIGNING_KEY=${QSTASH_DEV.QSTASH_CURRENT_SIGNING_KEY}, QSTASH_NEXT_SIGNING_KEY=${QSTASH_DEV.QSTASH_NEXT_SIGNING_KEY}. put them in the env of every service that talks to qstash, under the names the code actually reads.
- cmd: an argv array. a single shell line with "shell": true only when it truly needs \`source\` or \`&&\`. cwd is relative to the repo root.
- ready: {"path": "/"} for http services (any http response counts; add "status" only if one code matters; for an api pick a cheap GET like /health or /docs), or {"log": "regex"} for services without http. frontends may take minutes on first compile: "timeoutSec": 240.
- notes: one line each, only what the developer must know (e.g. "api cors allows only localhost:3000 — set ALLOWED_ORIGINS"). at most 6.

reply with ONE sentence, then exactly one block:
\`\`\`lambda-stack
{"services": [{"name": "api", "role": "api", "cwd": "api", "cmd": ["…"], "port": {"env": "PORT"}, "ready": {"path": "/health"}, "optional": false}],
 "setup": [],
 "env": {"frontend": {"NEXT_PUBLIC_API_URL": "\${url:api}"}},
 "envFiles": ["api/.env"],
 "notes": []}
\`\`\`
the JSON must be valid.
`.trim();
