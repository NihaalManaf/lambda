import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CliTool } from "./types";

// Detect CLIs the agents can use. `which` + `--version`, no shell, short timeouts, cached 60s.

const run = promisify(execFile);

export const CLI_TOOLS = [
  "claude", "codex", "gh", "git", "supabase", "stripe", "aws", "gcloud", "vercel", "railway",
  "fly", "docker", "psql", "linear", "sentry-cli", "npm", "bun", "node", "playwright",
];

// odd ones out: flags that print a version fast
const VERSION_ARGS: Record<string, string[]> = { gcloud: ["version"], fly: ["version"], docker: ["--version"] };

// GUI apps launched from Finder get a thin PATH; widen it with the usual install spots.
const HOME = process.env.HOME ?? "";
export const PATH = [
  process.env.PATH,
  "/opt/homebrew/bin",
  "/usr/local/bin",
  `${HOME}/.local/bin`,
  `${HOME}/.bun/bin`,
  `${HOME}/.fly/bin`,
  `${HOME}/.npm-global/bin`,
]
  .filter(Boolean)
  .join(":");
// vars that describe *this* server (set by the mac app / next), not the agent's world: an agent that
// starts its own dev server or an electron CLI must not inherit them
const SERVER_ONLY = ["ELECTRON_RUN_AS_NODE", "PORT", "HOSTNAME", "NODE_ENV", "LAMBDA_SERVER_ENTRY", "LAMBDA_DATA_DIR", "LAMBDA_NONCE", "NEXT_RUNTIME", "__NEXT_PRIVATE_ORIGIN"];
export const toolEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH };
  for (const k of SERVER_ONLY) delete env[k];
  return env;
};
const env = toolEnv();

async function probe(name: string): Promise<CliTool> {
  try {
    const { stdout } = await run("which", [name], { timeout: 2000, env });
    const bin = stdout.trim();
    if (!bin) return { name, installed: false };
    let version: string | undefined;
    try {
      const out = await run(bin, VERSION_ARGS[name] ?? ["--version"], { timeout: 3000, env });
      const line = (out.stdout || out.stderr).split("\n").find((l) => l.trim()) ?? "";
      version = line.match(/\d+\.\d+(\.\d+)?([-.\w]*)?/)?.[0] ?? line.trim().slice(0, 24);
    } catch {
      /* installed, version unknown */
    }
    return { name, installed: true, path: bin, version };
  } catch {
    return { name, installed: false };
  }
}

let cache: { at: number; tools: Promise<CliTool[]> } | null = null;

export function detectCli(): Promise<CliTool[]> {
  if (!cache || Date.now() - cache.at > 60_000) {
    const tools = Promise.all(CLI_TOOLS.map(probe));
    cache = { at: Date.now(), tools };
    tools.catch(() => (cache = null));
  }
  return cache.tools;
}
