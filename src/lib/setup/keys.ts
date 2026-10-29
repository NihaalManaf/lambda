import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "../env";
import { readText } from "./ctx";

// lambda's own key file (DATA_DIR/keys.env, 0600). Pasted keys live here — never in the user's repo.
// env.ts reads it as the fallback under settings.envPath.

export const keysFile = (dataDir: string) => path.join(dataDir, "keys.env");

export function ownKeys(dataDir: string): Record<string, string> {
  return parseEnv(readText(keysFile(dataDir), 64 * 1024));
}

export function hasKeyOutsideRepo(name: string, dataDir: string): boolean {
  return Boolean(ownKeys(dataDir)[name] || process.env[name]);
}

const VALID: Record<string, RegExp> = { ANTHROPIC_API_KEY: /^sk-ant-[\w-]{20,300}$/ };

export function validKey(name: string, value: unknown): value is string {
  return typeof value === "string" && (VALID[name] ?? /^[\x21-\x7e]{8,500}$/).test(value);
}

export function writeOwnKey(dataDir: string, name: string, value: string) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || !validKey(name, value)) throw new Error(`invalid ${name}`);
  const keys = { ...ownKeys(dataDir), [name]: value };
  const body = Object.entries(keys).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = keysFile(dataDir);
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; // concurrent applies never share a temp file
  fs.writeFileSync(tmp, `# written by lambda setup — keys pasted in the app\n${body}`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}
