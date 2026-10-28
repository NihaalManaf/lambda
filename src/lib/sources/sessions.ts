import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clip, type SessionDigest, type SessionMeta } from "./types";

// Past Claude Code sessions: ~/.claude/projects/<encoded-cwd>/<session>.jsonl
// Files can be tens of MB, so we only ever read a head chunk (meta) or tail chunk (digest).

export const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

const HEAD = 256 * 1024;
const HEAD_MAX = 2 * 1024 * 1024;
const TAIL = 1024 * 1024;

type Line = {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  cwd?: string;
  message?: { role?: string; content?: unknown };
};


// Noise: slash commands, caveats, hook output, interrupts, system reminders.
const NOISE = /^(<[a-z-]+>|\[Request interrupted|Caveat:|This session is being continued)/i;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function userPrompt(l: Line): string | null {
  if (l.type !== "user" || l.isMeta || l.isSidechain) return null;
  const c = l.message?.content;
  if (Array.isArray(c) && c.some((b) => b?.type === "tool_result")) return null;
  const t = textOf(c)
    .replace(/<\/?pasted_content[^>]*>/g, "")
    .trim();
  return t && !NOISE.test(t) ? t : null;
}

// A row title: the first plain-language line (not pasted markup, file dumps or image refs).
const JUNK_LINE = /^(\[?<|\[Image|Read \/(tmp|private)\/|```|[{}[\]]|\/[\w-]+\s*$)/i;
function titleLine(prompt: string): string | null {
  for (const raw of prompt.split("\n")) {
    const l = raw.trim();
    if (!l || JUNK_LINE.test(l)) continue;
    if ((l.match(/[a-z]{2,}/gi) ?? []).length < 3) continue; // needs a few real words
    return l.replace(/\s+/g, " ");
  }
  return null;
}

function assistantText(l: Line): string | null {
  if (l.type !== "assistant" || l.isSidechain) return null;
  const t = textOf(l.message?.content).trim();
  return t || null;
}

function parseLines(chunk: string, dropFirst: boolean): Line[] {
  const lines = chunk.split("\n");
  if (dropFirst) lines.shift(); // partial line at chunk start
  const out: Line[] = [];
  for (const raw of lines) {
    if (!raw.startsWith("{")) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      /* partial line at chunk end */
    }
  }
  return out;
}

function readRange(file: string, start: number, len: number): string {
  const fd = fs.openSync(/*turbopackIgnore: true*/ file, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

const decodeDir = (dir: string) => dir.replace(/-/g, "/");

function readMeta(file: string, dir: string, stat: fs.Stats): SessionMeta {
  let prompt = "";
  let cwd = "";
  let msgs = 0;
  let scanned = 0;
  let lines: Line[] = [];
  // grow the head window until we find a real prompt (or give up)
  for (let len = HEAD; scanned < stat.size && len <= HEAD_MAX; len *= 2) {
    const chunk = readRange(file, 0, Math.min(len, stat.size));
    scanned = Buffer.byteLength(chunk);
    lines = parseLines(chunk, false);
    for (const l of lines) {
      cwd ||= l.cwd ?? "";
      const p = userPrompt(l);
      const t = p && titleLine(p);
      if (t) {
        prompt = t;
        break;
      }
    }
    if (prompt) break;
  }
  for (const l of lines) if (userPrompt(l) || assistantText(l)) msgs++;
  const messages = scanned >= stat.size ? msgs : Math.round((msgs * stat.size) / Math.max(scanned, 1));
  return {
    id: path.basename(file, ".jsonl"),
    project: cwd || decodeDir(dir),
    prompt: clip(prompt || "(no prompt)", 120),
    modified: stat.mtime.toISOString(),
    messages,
    bytes: stat.size,
  };
}

// mtime-keyed cache so repeated listing is cheap
const cache = new Map<string, { mtimeMs: number; meta: SessionMeta }>();

function allFiles(): { file: string; dir: string; stat: fs.Stats }[] {
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return [];
  }
  const out: { file: string; dir: string; stat: fs.Stats }[] = [];
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(PROJECTS_DIR, dir)).filter((n) => n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const n of names) {
      const file = path.join(PROJECTS_DIR, dir, n);
      try {
        const stat = fs.statSync(/*turbopackIgnore: true*/ file);
        if (stat.isFile() && stat.size > 0) out.push({ file, dir, stat });
      } catch {
        /* vanished */
      }
    }
  }
  return out.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
}

export function listSessions(opts: { q?: string; limit?: number } = {}): SessionMeta[] {
  const q = opts.q?.trim().toLowerCase();
  const limit = Math.min(opts.limit ?? 100, 100);
  const out: SessionMeta[] = [];
  for (const { file, dir, stat } of allFiles()) {
    let hit = cache.get(file);
    if (!hit || hit.mtimeMs !== stat.mtimeMs) {
      hit = { mtimeMs: stat.mtimeMs, meta: readMeta(file, dir, stat) };
      cache.set(file, hit);
    }
    const m = hit.meta;
    if (m.prompt === "(no prompt)" && !q) continue; // empty /clear-only sessions
    if (q && !`${m.prompt} ${m.project}`.toLowerCase().includes(q)) continue;
    out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}

function findFile(sessionId: string): string | undefined {
  if (!/^[\w-]+$/.test(sessionId)) return undefined;
  for (const { file } of allFiles()) if (path.basename(file, ".jsonl") === sessionId) return file;
}

export function getSessionDigest(sessionId: string, n = 4): SessionDigest | undefined {
  const file = findFile(sessionId);
  if (!file) return undefined;
  const size = fs.statSync(/*turbopackIgnore: true*/ file).size;
  const start = Math.max(0, size - TAIL);
  const lines = parseLines(readRange(file, start, size - start), start > 0);
  const turns: SessionDigest["turns"] = [];
  let cwd = "";
  for (const l of lines) {
    cwd = l.cwd ?? cwd;
    const u = userPrompt(l);
    if (u) turns.push({ role: "user", text: clip(u, 200) });
    const a = assistantText(l);
    if (a) {
      // keep only the assistant's last text per turn ("final" answer)
      const last = turns[turns.length - 1];
      if (last?.role === "assistant") last.text = clip(a, 240);
      else turns.push({ role: "assistant", text: clip(a, 240) });
    }
  }
  const tail = turns.slice(-n * 2);
  const meta = listSessions({ limit: 100 }).find((m) => m.id === sessionId);
  const asks = tail.filter((t) => t.role === "user").map((t) => `→ ${clip(t.text, 90)}`);
  const result = [...tail].reverse().find((t) => t.role === "assistant");
  const excerpt = clip(
    [asks.join(" ") || meta?.prompt, result && `· result: ${result.text}`].filter(Boolean).join(" "),
    400,
  );
  return { id: sessionId, project: cwd || meta?.project || "", turns: tail, excerpt };
}
