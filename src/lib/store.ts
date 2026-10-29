import "server-only";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { nanoid } from "nanoid";
import { migrateFeature } from "./pieces";
import type { Feature, FeatureMode, Settings } from "./types";

// Local-first JSON store. Single user; writes are serialised in process and across processes (lockfile).

// One store for every mode (web dev, app:dev, the installed app): on macOS that is
// ~/Library/Application Support/lambda/data. LAMBDA_DATA_DIR overrides; elsewhere ./data.
export const APP_DATA_DIR = path.join(os.homedir(), "Library", "Application Support", "lambda", "data");
export const DATA_DIR =
  process.env.LAMBDA_DATA_DIR || (process.platform === "darwin" ? APP_DATA_DIR : path.join(process.cwd(), "data"));
export const SHOTS_DIR = path.join(DATA_DIR, "shots");
const FEATURES_FILE = path.join(DATA_DIR, "features.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json"); // holds test passwords: 0600

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(SHOTS_DIR, { recursive: true });

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

// 0600: features.json holds run logs + context pulled from slack/linear/sessions.
function writeJson(file: string, data: unknown, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
  fs.renameSync(tmp, file);
}

export const id = (prefix: string) => `${prefix}_${nanoid(8)}`;
export const now = () => new Date().toISOString();

// ---------- settings ----------

export function defaultSettings(): Settings {
  return {
    envPath: "", // empty: keys come from lambda's own .env.local / process env
    frontendUrl: "http://localhost:3000",
    repoPath: "", // set in /settings: the app repo lambda reads + tests
    baseBranch: "", // "" = auto-detect main / master (defaultBranch())
    edgeCases: true,
    model: "claude-opus-5-5",
    accounts: [],
    appHosts: [],
    migrationsDir: "migrations",
    extraMigrationDirs: [],
    baselineSchemaPath: "",
    queueIgnore: ["node_modules", ".git", ".next", "venv", ".venv", "dist", "build", "__pycache__"],
  };
}

export function getSettings(): Settings {
  return { ...defaultSettings(), ...readJson<Partial<Settings>>(SETTINGS_FILE, {}) };
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  writeJson(SETTINGS_FILE, next, 0o600);
  return next;
}

// ---------- features ----------

// Read path migrates pre-pieces features (src/lib/pieces.ts); the migrated shape is persisted on the next write.
export function listFeatures(): Feature[] {
  return readJson<Feature[]>(FEATURES_FILE, [])
    .map(migrateFeature)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getFeature(featureId: string): Feature | undefined {
  return listFeatures().find((f) => f.id === featureId);
}

// New features start in the intake conversation: no pieces, no generation until the brief settles.
export function createFeature(title: string, brief: string, phase: Feature["phase"] = "intake", mode: FeatureMode = "build"): Promise<Feature> {
  const f: Feature = {
    id: id("ft"),
    title,
    brief,
    phase,
    ...(mode === "understand" ? { mode } : {}), // build stays absent, like pre-mode data
    status: "shaping",
    createdAt: now(),
    updatedAt: now(),
    context: [],
    pieces: [],
  };
  return locked(() => {
    writeJson(FEATURES_FILE, [f, ...listFeatures()]);
    return f;
  });
}

// Read-modify-write, serialised twice over:
// - in process: one promise chain on globalThis (an HMR re-eval of this module must not start a second chain)
// - across processes (the installed app + `next dev` share DATA_DIR): an O_EXCL lockfile around each RMW
const LOCK_FILE = path.join(DATA_DIR, "features.lock");
const LOCK_STALE_MS = 30_000;
const G = globalThis as { __lambdaStoreLock?: Promise<unknown> };
G.__lambdaStoreLock ??= Promise.resolve();

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function acquireFileLock() {
  for (let tries = 0; ; tries++) {
    try {
      const fd = fs.openSync(LOCK_FILE, "wx", 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      const pid = Number(fs.readFileSync(LOCK_FILE, "utf8"));
      const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      // our own pid can't legitimately hold it here (the in-process chain is serial): left by a crash/HMR
      if (age > LOCK_STALE_MS || (pid > 0 && (pid === process.pid || !pidAlive(pid)))) {
        fs.rmSync(LOCK_FILE, { force: true });
        continue;
      }
    } catch {
      continue; // released between our open and read
    }
    if (tries > 3000) throw new Error("store busy — another lambda process holds the lock");
    await new Promise((r) => setTimeout(r, 8 + Math.random() * 12));
  }
}

const releaseFileLock = () => {
  try {
    if (Number(fs.readFileSync(LOCK_FILE, "utf8")) === process.pid) fs.rmSync(LOCK_FILE, { force: true });
  } catch {
    /* already gone */
  }
};

function locked<T>(work: () => T | Promise<T>): Promise<T> {
  const run = G.__lambdaStoreLock!.then(async () => {
    await acquireFileLock();
    try {
      return await work();
    } finally {
      releaseFileLock();
    }
  });
  G.__lambdaStoreLock = run.catch(() => undefined);
  return run;
}

export function updateFeature(featureId: string, mutate: (f: Feature) => void | Promise<void>): Promise<Feature> {
  return locked(async () => {
    const all = listFeatures();
    const f = all.find((x) => x.id === featureId);
    if (!f) throw new Error(`feature ${featureId} not found`);
    await mutate(f);
    f.updatedAt = now();
    writeJson(FEATURES_FILE, all);
    return f;
  });
}

export async function deleteFeature(featureId: string) {
  await locked(() => writeJson(FEATURES_FILE, listFeatures().filter((f) => f.id !== featureId)));
}
