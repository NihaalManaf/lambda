// Pure helpers for verification runs (no server-only: unit-testable with tsx).
// Claude Code `-p --output-format stream-json --verbose` → short human log lines + final verdict.

import type { VerificationRun } from "./types";

export interface Verdict {
  passed: boolean;
  failures: string[];
  summary: string;
}

// VerificationRun + failures (extra field persisted alongside; types.ts has no slot for it).
export type Run = VerificationRun & { failures?: string[] };

export const TERMINAL = new Set(["passed", "failed", "error"]);
export const RUN_ID = /^run_[A-Za-z0-9_-]{1,40}$/;
export const SHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(png|jpe?g|webp)$/i;

export const short = (s: string, n = 140) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// Replace every occurrence of each secret (raw, url-encoded, json-escaped) with •••.
// Apply to the RAW stream line before parsing/truncating, so a cut can't leave a partial secret.
export function redactor(secrets: (string | undefined)[]) {
  const list = [
    ...new Set(
      secrets
        .filter((s): s is string => !!s && s.length >= 3)
        .flatMap((s) => [s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1)]),
    ),
  ].sort((a, b) => b.length - a.length);
  return (line: string) => list.reduce((acc, s) => acc.split(s).join("•••"), line);
}

export const toolLabel = (name: string) =>
  name
    .replace(/^mcp__playwright__browser_/, "")
    .replace(/^mcp__[^_]+__/, "")
    .replace(/_/g, " ");

type Json = Record<string, unknown>;

// password-ish fields are masked regardless of redaction
const SECRETISH = /pass|secret|token|otp|pin\b/i;
const masked = (label: unknown, value: unknown, n: number) =>
  SECRETISH.test(String(label ?? "")) ? "•••" : short(String(value ?? ""), n);

function toolArgs(input: Json = {}): string {
  const fields = Array.isArray(input.fields)
    ? (input.fields as Json[])
        .map((f) => `${f.name ?? "field"}=${f.type === "password" ? "•••" : masked(f.name, f.value, 30)}`)
        .join(", ")
    : undefined;
  const parts = [
    input.url,
    input.element,
    input.text !== undefined ? `"${masked(input.element, input.text, 40)}"` : undefined,
    input.key,
    Array.isArray(input.values) ? (input.values as unknown[]).join(", ") : undefined,
    fields,
    input.filename,
  ].filter((p) => p !== undefined && p !== "");
  return short(parts.map(String).join(" · "), 110);
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((c: Json) => (c?.type === "text" ? String(c.text ?? "") : "")).join(" ");
  return "";
}

export interface Parsed {
  lines: string[];
  result?: { text: string; ok: boolean; turns?: number; ms?: number };
}

// One stream-json line → zero or more log lines. Caller passes an already-redacted raw line.
export function parseStreamLine(raw: string): Parsed {
  let ev: Json;
  try {
    ev = JSON.parse(raw);
  } catch {
    return { lines: [] };
  }
  const msg = ev.message as Json | undefined;
  switch (ev.type) {
    case "system": {
      if (ev.subtype !== "init") return { lines: [] };
      const mcp = (ev.mcp_servers as Json[] | undefined)?.map((s) => `${s.name}:${s.status}`).join(" ");
      return { lines: [`agent up${mcp ? ` · ${mcp}` : ""}`] };
    }
    case "assistant": {
      const lines: string[] = [];
      for (const c of (msg?.content as Json[]) ?? []) {
        if (c.type === "text" && String(c.text).trim()) lines.push(short(String(c.text)));
        if (c.type === "tool_use") {
          const args = toolArgs(c.input as Json);
          lines.push(`→ ${toolLabel(String(c.name))}${args ? ` · ${args}` : ""}`);
        }
      }
      return { lines };
    }
    case "user": {
      const lines: string[] = [];
      for (const c of (msg?.content as Json[]) ?? []) {
        if (c?.type === "tool_result" && c.is_error) lines.push(`✗ ${short(resultText(c.content), 120)}`);
      }
      return { lines };
    }
    case "result": {
      const ok = ev.subtype === "success" && !ev.is_error;
      const secs = typeof ev.duration_ms === "number" ? Math.round(ev.duration_ms / 1000) : undefined;
      return {
        lines: [`done · ${ev.num_turns ?? "?"} turns${secs !== undefined ? ` · ${secs}s` : ""}`],
        result: { text: String(ev.result ?? ""), ok, turns: ev.num_turns as number, ms: ev.duration_ms as number },
      };
    }
    default:
      return { lines: [] };
  }
}

function coerce(v: unknown): Verdict | null {
  if (!v || typeof v !== "object" || typeof (v as Json).passed !== "boolean") return null;
  const o = v as Json;
  const failures = Array.isArray(o.failures) ? o.failures.map((x) => short(String(x), 160)).slice(0, 12) : [];
  const summary = short(String(o.summary ?? "").split(/\s+/).slice(0, 20).join(" "), 160);
  return { passed: o.passed as boolean, failures, summary };
}

// Final line JSON {"passed":bool,"failures":[...],"summary":"..."} — tolerant of fences / trailing prose.
export function parseVerdict(text: string): Verdict | null {
  const lines = text.split("\n").map((l) => l.replace(/`/g, "").trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      const v = coerce(JSON.parse(lines[i]));
      if (v) return v;
    } catch {}
  }
  const at = text.lastIndexOf('"passed"');
  if (at < 0) return null;
  const start = text.lastIndexOf("{", at);
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= at) return null;
  try {
    return coerce(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return null;
  }
}
