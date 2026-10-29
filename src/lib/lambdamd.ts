import "server-only";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, getSettings } from "./store";

// lambda.md: the developer's standing instructions to every agent lambda runs
// (intake Claude Code session, ask_codebase, all generations). Two layers:
//   1. user copy in DATA_DIR/lambda.md (edited in settings; falls back to the default below)
//   2. <repoPath>/lambda.md if the repo has one — team conventions, appended after

export const DEFAULT_LAMBDA_MD = `# lambda.md

how we build. every agent lambda runs reads this first.

## understand the fundamentals
- before proposing anything, understand what we're actually building and why: the user, the job, the outcome.
- read the real code first. name real files, routes, tables, services.
- if the fundamentals are unclear, ask — one short question beats a wrong plan.

## keep the build as simple as possible
- smallest change that fully solves the problem. no speculative abstractions, no config nobody asked for.
- fewer moving parts > clever parts. one table over three, one endpoint over two.
- split into separate PRs only when pieces are genuinely independent and each ships + verifies alone.

## reuse what exists
- reuse existing APIs, components, helpers, tables and queues before creating new ones.
- extend an existing pattern instead of inventing a parallel one. match the codebase's conventions.
- if something new is truly needed, say why the existing thing doesn't fit.

## manifesto
- slop is the enemy of understanding. short, concrete, no filler.
- put developer attention where it pays: surface decisions and edge cases, not prose.
- a diagram beats a hundred paragraphs.
- everything must be verifiable in a browser.
`;

const USER_FILE = path.join(DATA_DIR, "lambda.md");
const MAX = 12_000; // chars per layer — a prompt preamble, not a manual

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").slice(0, MAX);
  } catch {
    return null;
  }
}

export function repoLambdaMdPath(): string | null {
  const { repoPath } = getSettings();
  return repoPath ? path.join(repoPath, "lambda.md") : null;
}

export function getLambdaMd(): { text: string; isDefault: boolean; repo: { path: string; text: string } | null } {
  const user = read(USER_FILE);
  const rp = repoLambdaMdPath();
  const repoText = rp ? read(rp) : null;
  return { text: user ?? DEFAULT_LAMBDA_MD, isDefault: user == null, repo: rp && repoText ? { path: rp, text: repoText } : null };
}

// null resets to the default
export function saveLambdaMd(text: string | null) {
  if (text == null) return void fs.rmSync(USER_FILE, { force: true });
  fs.writeFileSync(USER_FILE, text.slice(0, MAX), { mode: 0o600 });
}

// The block injected into agent system prompts.
export function lambdaPrompt(): string {
  const { text, repo } = getLambdaMd();
  const parts = [`<lambda_md source="developer">\n${text.trim()}\n</lambda_md>`];
  if (repo) parts.push(`<lambda_md source="repo">\n${repo.text.trim()}\n</lambda_md>`);
  return `Follow the developer's standing instructions below for everything you produce.\n\n${parts.join("\n\n")}`;
}
