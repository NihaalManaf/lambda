// Find + order migration files. 8-digit prefixes pad to 14 so `20260310_x` sorts before `20260310193000_y`
// (and before `20260310000000_y`: a bare date runs first that day); the full name breaks remaining ties.
import fs from "node:fs";
import path from "node:path";

export interface MigFile { id: string; file: string /* repo-rel */; abs: string; prefix: string; date: string; dupPrefix: boolean }

export const prefixOf = (name: string) => name.match(/^\d+/)?.[0] ?? "";
export const sortKey = (name: string) => {
  const p = prefixOf(name);
  return `${p.padEnd(14, "0")}|${p.length < 14 ? 0 : 1}|${name}`;
};

export function dateOf(prefix: string) {
  const m = prefix.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

export function listMigrations(repo: string, dirs: string[]): MigFile[] {
  const found: MigFile[] = [];
  for (const dir of dirs) {
    const abs = path.resolve(repo, dir);
    let names: string[] = [];
    try {
      names = fs.readdirSync(abs).filter((f) => f.endsWith(".sql"));
    } catch {
      continue;
    }
    for (const name of names) {
      const prefix = prefixOf(name);
      found.push({ id: name, file: path.join(dir, name), abs: path.join(abs, name), prefix, date: dateOf(prefix), dupPrefix: false });
    }
  }
  found.sort((a, b) => (sortKey(a.id) < sortKey(b.id) ? -1 : sortKey(a.id) > sortKey(b.id) ? 1 : a.file.localeCompare(b.file)));
  const seen = new Map<string, MigFile[]>();
  const ids = new Set<string>();
  for (const f of found) {
    if (f.prefix) seen.set(f.prefix, [...(seen.get(f.prefix) ?? []), f]);
    // ids are filenames; the same name in two dirs gets the dir folded in
    if (ids.has(f.id)) f.id = f.file.replace(/[\\/]/g, "~");
    ids.add(f.id);
  }
  for (const group of seen.values()) if (group.length > 1) group.forEach((f) => (f.dupPrefix = true));
  return found;
}
