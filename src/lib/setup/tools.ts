import "server-only";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { toolEnv } from "../sources/cli";
import { maskEmail, timeBox } from "./ctx";

// The machine half of setup: which CLIs exist, is claude logged in, is a browser installed.

const run = promisify(execFile);

export type Tool = { name: string; installed: boolean; version?: string };
export type ClaudeAuth = { loggedIn: boolean; authMethod?: string; email?: string } | null; // null: couldn't tell
export type Chromium = { installed: boolean; revision?: string; headlessShell?: boolean };
export type ToolsReport = { tools: Tool[]; claude: Tool & { auth: ClaudeAuth }; chromium: Chromium };

const TOOL_NAMES = ["node", "npm", "git", "python3"];

async function probe(name: string): Promise<Tool> {
  const env = toolEnv();
  try {
    const bin = (await run("which", [name], { timeout: 2000, env })).stdout.trim();
    if (!bin) return { name, installed: false };
    try {
      const out = await run(bin, ["--version"], { timeout: 4000, env });
      const v = (out.stdout || out.stderr).match(/\d+\.\d+(\.\d+)?/)?.[0];
      return { name, installed: true, version: v };
    } catch {
      return { name, installed: true };
    }
  } catch {
    return { name, installed: false };
  }
}

export async function claudeAuth(): Promise<ClaudeAuth> {
  try {
    const { stdout } = await run("claude", ["auth", "status"], { timeout: 6000, env: toolEnv() });
    const j = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; email?: string };
    return { loggedIn: Boolean(j.loggedIn), authMethod: j.authMethod, email: j.email ? maskEmail(j.email) : undefined };
  } catch (e) {
    // `auth status` exits non-zero when logged out but still prints json
    const out = (e as { stdout?: string }).stdout;
    try {
      const j = JSON.parse(out ?? "") as { loggedIn?: boolean; authMethod?: string };
      return { loggedIn: Boolean(j.loggedIn), authMethod: j.authMethod };
    } catch {
      return null;
    }
  }
}

// Playwright's own answer: the exact revision this lambda's playwright expects. capture.ts launches
// `headless: true`, which runs the headless shell of that revision — that's the one that must exist.
export async function chromiumStatus(): Promise<Chromium> {
  try {
    const { chromium } = await import("playwright");
    const exe = chromium.executablePath();
    const rev = exe.match(/chromium-(\d+)/)?.[1];
    if (!rev) return { installed: fs.existsSync(exe) };
    const cache = exe.slice(0, exe.indexOf(`chromium-${rev}`));
    const headlessShell = fs.existsSync(path.join(cache, `chromium_headless_shell-${rev}`));
    return { installed: headlessShell, revision: rev, headlessShell };
  } catch {
    return { installed: false };
  }
}

export async function detectTools(): Promise<ToolsReport> {
  const [tools, claude, auth, chromium] = await Promise.all([
    Promise.all(TOOL_NAMES.map((n) => timeBox(probe(n), 5000, { name: n, installed: false }))),
    timeBox(probe("claude"), 5000, { name: "claude", installed: false }),
    timeBox(claudeAuth(), 7000, null),
    timeBox(chromiumStatus(), 3000, { installed: false }),
  ]);
  return { tools, claude: { ...claude, auth: claude.installed ? auth : { loggedIn: false } }, chromium };
}

// ---------- install chromium ----------

export type InstallEvent = { type: "line"; text: string } | { type: "done"; ok: boolean; chromium?: Chromium } | { type: "error"; message: string };

const G = globalThis as { __lambdaChromiumInstall?: boolean };
const INSTALL_MS = 10 * 60_000;

// `npx playwright install chromium` with this checkout's playwright, args array, no shell, time-boxed.
export function installChromium(emit: (e: InstallEvent) => void, signal?: AbortSignal): Promise<void> {
  if (G.__lambdaChromiumInstall) {
    emit({ type: "error", message: "an install is already running" });
    return Promise.resolve();
  }
  G.__lambdaChromiumInstall = true;
  return new Promise<void>((resolve) => {
    // this checkout's playwright when present (same browser revision capture.ts launches), else a pinned one
    const local = fs.existsSync(path.join(process.cwd(), "node_modules", "playwright", "package.json"));
    const args = local ? ["--no", "playwright", "install", "chromium"] : ["--yes", "playwright@1.64.1", "install", "chromium"];
    const child = spawn("npx", args, {
      cwd: process.cwd(),
      env: toolEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), INSTALL_MS);
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort);
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      const parts = buf.split(/\r?\n|\r/);
      buf = parts.pop() ?? "";
      for (const p of parts) if (p.trim()) emit({ type: "line", text: p.trim().slice(0, 300) });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    let finished = false;
    const finish = async (ok: boolean, message?: string) => {
      if (finished) return; // 'error' and 'close' can both fire
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      G.__lambdaChromiumInstall = false;
      if (buf.trim()) emit({ type: "line", text: buf.trim().slice(0, 300) });
      if (message) emit({ type: "error", message });
      emit({ type: "done", ok, chromium: await chromiumStatus() });
      resolve();
    };
    child.on("error", (e) => void finish(false, e.message));
    child.on("close", (code, sig) => void finish(code === 0, code === 0 ? undefined : sig ? `stopped (${sig})` : `exited ${code}`));
  });
}
