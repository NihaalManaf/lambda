// Parsed-file effects cache: sha1(content) -> {ops, error}, in memory + on disk.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ParseResult } from "./parse";

export const PARSE_VERSION = "2"; // bump when parse.ts output changes: old entries miss
export const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

export class EffectCache {
  private map: Record<string, ParseResult> = {};
  private dirty = false;
  constructor(private file?: string) {
    if (!file) return;
    try {
      this.map = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      this.map = {};
    }
  }
  key = (content: string) => sha1(`${PARSE_VERSION}\0${content}`);
  get = (k: string): ParseResult | undefined => this.map[k];
  set(k: string, v: ParseResult) {
    this.map[k] = v;
    this.dirty = true;
  }
  save() {
    if (!this.file || !this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.map));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch {
      /* cache is best effort */
    }
  }
}

// (relpath, mtimeMs, size) per file: unchanged signature = unchanged head
export function statOf(abs: string): { mtimeMs: number; size: number } | null {
  try {
    const st = fs.statSync(abs);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}
