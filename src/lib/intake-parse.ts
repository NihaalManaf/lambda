import { z } from "zod";
import type { Brief, ChatMessage } from "./types";

// Pure parsing for the intake conversation (client + server):
// - lambda-ask / lambda-brief fenced blocks out of the session's reply
// - Claude Code `--output-format stream-json` lines → small events
// - the visible part of a reply still streaming (half-written fences hidden)

export type Ask = NonNullable<ChatMessage["ask"]>;

const str = z.string().transform((s) => s.trim());
const strs = z
  .array(z.unknown())
  .default([])
  .transform((xs) => xs.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean));

export const AskSchema = z.object({
  question: str.pipe(z.string().min(1)),
  options: strs.transform((xs) => [...new Set(xs)].slice(0, 6)),
  multi: z.boolean().optional().default(false),
});

// what the session writes (lenient: missing lists → [], pieces 1..5)
export const BriefSchema = z.object({
  summary: str.pipe(z.string().min(1, "summary is empty")),
  roles: strs,
  inScope: strs,
  outOfScope: strs,
  decisions: z
    .array(z.object({ q: str, a: str }))
    .default([])
    .transform((ds) => ds.filter((d) => d.q && d.a)),
  openQuestions: strs,
  surfaces: strs,
  pieces: z
    .array(z.object({ title: str.pipe(z.string().min(1, "piece title is empty")), why: z.string().default("").transform((s) => s.trim()), scope: strs }))
    .min(1, "at least one piece")
    .transform((ps) => ps.slice(0, 5)),
});

// for structured output (skip path): plain shapes, no defaults/transforms
export const BriefGenSchema = z.object({
  summary: z.string().describe("<= 40 words"),
  roles: z.array(z.string()).describe("user types"),
  inScope: z.array(z.string()).describe("each <= 10 words"),
  outOfScope: z.array(z.string()).describe("each <= 10 words"),
  decisions: z.array(z.object({ q: z.string(), a: z.string() })).describe("what is already settled"),
  openQuestions: z.array(z.string()).describe("unknowns left for edge cases"),
  surfaces: z.array(z.string()).describe("screens / routes / tables / services touched"),
  pieces: z
    .array(z.object({ title: z.string().describe("<= 6 words"), why: z.string().describe("<= 15 words"), scope: z.array(z.string()) }))
    .describe("1..5 ordered PRs; one unless it genuinely should ship separately"),
});

export function validateBrief(raw: unknown): { brief: Brief } | { error: string } {
  const r = BriefSchema.safeParse(raw);
  if (r.success) return { brief: r.data };
  return { error: r.error.issues.slice(0, 4).map((i) => `${i.path.join(".") || "brief"}: ${i.message}`).join("; ") };
}

// ---------- fenced blocks ----------

const FENCE = /```lambda-(ask|brief)\b([\s\S]*?)```/g;
const MAX_ASKS = 3;

export interface ParsedReply {
  text: string; // reply with the blocks stripped
  asks: Ask[];
  brief?: Brief;
  briefError?: string; // a lambda-brief block was present but invalid
}

const tidy = (s: string) => s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

function json(body: string): unknown {
  const t = body.trim();
  try {
    return JSON.parse(t);
  } catch {
    // tolerate a stray language tag / prose line before the object
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("not json");
  }
}

export function parseReply(raw: string): ParsedReply {
  const asks: Ask[] = [];
  let brief: Brief | undefined;
  let briefError: string | undefined;
  const text = raw.replace(FENCE, (_m, kind: string, body: string) => {
    let data: unknown;
    try {
      data = json(body);
    } catch {
      if (kind === "brief") briefError = "lambda-brief is not valid JSON";
      return "";
    }
    if (kind === "ask") {
      const a = AskSchema.safeParse(data);
      if (a.success && asks.length < MAX_ASKS && !asks.some((x) => x.question === a.data.question)) asks.push(a.data);
    } else if (!brief) {
      const v = validateBrief(data);
      if ("brief" in v) {
        brief = v.brief;
        briefError = undefined;
      } else briefError = v.error;
    }
    return "";
  });
  return { text: tidy(text), asks, ...(brief ? { brief } : {}), ...(briefError && !brief ? { briefError } : {}) };
}

// While streaming: drop finished blocks, cut at an unclosed ```lambda- fence, and hide a trailing partial
// fence opener ("`", "``", "```lam…") so raw JSON never flashes on screen.
export function visibleText(raw: string): string {
  let s = raw.replace(FENCE, "");
  const open = s.indexOf("```lambda-");
  if (open >= 0) s = s.slice(0, open);
  const tail = s.match(/`{1,3}[a-z-]*$/);
  if (tail && "```lambda-".startsWith(tail[0].slice(0, 10))) s = s.slice(0, tail.index);
  return s.replace(/\n{3,}/g, "\n\n").trimStart();
}

// ---------- stream-json ----------

export type StreamEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "message" } // a new assistant message started (after tool use)
  | { kind: "text"; delta: string }
  | { kind: "tool"; line: string }
  | { kind: "assistant"; text: string } // a complete assistant message's text
  | { kind: "result"; ok: boolean; text: string; error?: string };

type Json = Record<string, unknown>;
const obj = (x: unknown): Json => (x && typeof x === "object" ? (x as Json) : {});

// relative, short path for the trace line
export function shortPath(p: string, cwd?: string): string {
  let s = p;
  if (cwd && s.startsWith(cwd)) s = s.slice(cwd.length).replace(/^\/+/, "") || ".";
  const parts = s.split("/");
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : s;
}

const clip = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function toolLine(name: string, input: unknown, cwd?: string): string {
  const i = obj(input);
  const p = typeof i.file_path === "string" ? i.file_path : typeof i.path === "string" ? i.path : "";
  switch (name) {
    case "Read":
      return `reading ${shortPath(p, cwd)}`;
    case "Grep":
      return `searching “${clip(String(i.pattern ?? ""), 36)}”${p ? ` in ${shortPath(p, cwd)}` : ""}`;
    case "Glob":
      return `listing ${clip(String(i.pattern ?? ""), 40)}`;
    case "LS":
      return `listing ${shortPath(p, cwd) || "."}`;
    case "Bash":
      return `running ${clip(String(i.command ?? "").split("\n")[0], 40)}`;
    case "Task":
    case "Agent":
      return "exploring the codebase";
    case "TodoWrite":
      return "planning";
    default:
      return `using ${name.replace(/^mcp__[^_]+__/, "").toLowerCase()}`;
  }
}

// One line of `claude -p --output-format stream-json --verbose --include-partial-messages` → events.
// Subagent traffic (parent_tool_use_id set) only contributes tool lines.
export function parseStreamLine(line: string, cwd?: string): StreamEvent[] {
  let m: Json;
  try {
    m = obj(JSON.parse(line));
  } catch {
    return [];
  }
  const out: StreamEvent[] = [];
  const sub = !!m.parent_tool_use_id;
  if (m.type === "system" && m.subtype === "init" && typeof m.session_id === "string") out.push({ kind: "session", sessionId: m.session_id });
  else if (m.type === "stream_event" && !sub) {
    const ev = obj(m.event);
    if (ev.type === "message_start") out.push({ kind: "message" });
    else if (ev.type === "content_block_delta") {
      const d = obj(ev.delta);
      if (d.type === "text_delta" && typeof d.text === "string" && d.text) out.push({ kind: "text", delta: d.text });
    }
  } else if (m.type === "assistant") {
    const content = Array.isArray(obj(m.message).content) ? (obj(m.message).content as unknown[]) : [];
    const texts: string[] = [];
    for (const b of content.map(obj)) {
      if (b.type === "tool_use" && typeof b.name === "string") out.push({ kind: "tool", line: toolLine(b.name, b.input, cwd) });
      else if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
    }
    if (!sub && texts.length) out.push({ kind: "assistant", text: texts.join("\n") });
  } else if (m.type === "result") {
    const text = typeof m.result === "string" ? m.result : "";
    const ok = m.subtype === "success" && !m.is_error;
    out.push({ kind: "result", ok, text, ...(ok ? {} : { error: text || String(m.subtype ?? "failed") }) });
  }
  return out;
}
