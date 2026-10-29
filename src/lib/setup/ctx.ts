import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "../store";

// Where the setup detectors look. Tests pass a temp `home` so nothing ever reads the real machine.
export type SetupCtx = {
  home: string;
  projectsDir: string; // ~/.claude/projects
  dataDir: string; // lambda's own data dir (keys.env lives here)
  selfDir: string; // lambda's own checkout: never offered as "your app"
  probe: boolean; // network probes (frontend up?) — off in tests
  now: number;
};

export function setupCtx(o: Partial<SetupCtx> = {}): SetupCtx {
  const home = o.home ?? os.homedir();
  return {
    home,
    projectsDir: o.projectsDir ?? path.join(home, ".claude", "projects"),
    dataDir: o.dataDir ?? DATA_DIR,
    selfDir: o.selfDir ?? process.cwd(),
    probe: o.probe ?? true,
    now: o.now ?? Date.now(),
  };
}

// dirs no detector descends into
export const SKIP_DIRS = new Set([
  "node_modules", ".git", "Library", ".next", "dist", "build", "out", "venv", ".venv", "env", "__pycache__",
  ".cache", ".turbo", "coverage", "target", "vendor", ".worktrees", ".claude", "Pods", ".idea", ".vscode", "tmp",
]);

export async function readDir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function readText(file: string, max = 256 * 1024): string {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(max);
      const n = fs.readSync(fd, buf, 0, max, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

export const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
export const isFile = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(readText(file, 1024 * 1024)) as T;
  } catch {
    return null;
  }
}

// realpath'd, absolute, existing, inside home — the only shape of path the setup routes accept.
export function safePath(p: unknown, home: string, kind: "dir" | "file"): string | null {
  if (typeof p !== "string" || !p || p.length > 1000 || !path.isAbsolute(p) || p.includes("\0")) return null;
  try {
    const real = fs.realpathSync(p);
    const h = fs.realpathSync(home);
    if (real !== h && !real.startsWith(h + path.sep)) return null;
    const st = fs.statSync(real);
    if (kind === "dir" ? !st.isDirectory() : !st.isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

export function timeBox<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    work.then(
      (v) => (clearTimeout(t), resolve(v)),
      () => (clearTimeout(t), resolve(fallback)),
    );
  });
}

export const maskEmail = (e: string) => {
  const [u, d] = e.split("@");
  if (!d) return e ? `${e.slice(0, 2)}…` : "";
  return `${u.slice(0, 2)}${u.length > 2 ? "…" : ""}@${d}`;
};
