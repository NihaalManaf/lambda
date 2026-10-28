import "server-only";
import fs from "node:fs";
import { getSettings } from "./store";

// BYOK: keys come from the user's webapp .env (path in settings), with process.env as fallback.

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

export function loadEnv(): Record<string, string> {
  const { envPath } = getSettings();
  try {
    return { ...parseEnv(fs.readFileSync(envPath, "utf8")) };
  } catch {
    return {};
  }
}

export function secret(name: string): string | undefined {
  return loadEnv()[name] || process.env[name] || undefined;
}

// Which keys exist (never values) — for the settings screen.
export function keyStatus(names: string[]): Record<string, boolean> {
  const env = loadEnv();
  return Object.fromEntries(names.map((n) => [n, Boolean(env[n] || process.env[n])]));
}
