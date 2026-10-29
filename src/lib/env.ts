import "server-only";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, getSettings } from "./store";

// BYOK: keys come from the user's webapp .env (path in settings), then lambda's own keys.env (keys pasted
// during setup — never written into the user's repo), then process.env.

export const KEYS_FILE = path.join(DATA_DIR, "keys.env");

export function parseEnv(text: string): Record<string, string> {
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
  const read = (f: string) => {
    try {
      return f ? parseEnv(fs.readFileSync(f, "utf8")) : {};
    } catch {
      return {};
    }
  };
  const own = read(KEYS_FILE);
  const app = read(envPath);
  for (const k of Object.keys(app)) if (!app[k]) delete app[k]; // an empty KEY= in the app env doesn't shadow ours
  return { ...own, ...app };
}

export function secret(name: string): string | undefined {
  return loadEnv()[name] || process.env[name] || undefined;
}

// Which keys exist (never values) — for the settings screen.
export function keyStatus(names: string[]): Record<string, boolean> {
  const env = loadEnv();
  return Object.fromEntries(names.map((n) => [n, Boolean(env[n] || process.env[n])]));
}
