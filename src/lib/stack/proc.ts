import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";

// One supervised stack process: spawned detached (it leads its own process group, so stop takes down
// everything it started — npm → next → workers, uvicorn's reloader), output kept in a redacted ring
// buffer, readiness by http probe or log regex.

export const RING_MAX = 400;

export type LogLine = { seq: number; at: number; service: string; stream: "out" | "err" | "sys"; line: string };

// counter: shared by a stack's rings, so one `since` works across every service's log
export class Ring {
  lines: LogLine[] = [];
  constructor(
    private max = RING_MAX,
    private counter = { n: 0 },
  ) {}
  push(service: string, stream: LogLine["stream"], line: string) {
    this.lines.push({ seq: ++this.counter.n, at: Date.now(), service, stream, line: line.slice(0, 2000) });
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }
  since(seq = 0, service?: string) {
    return this.lines.filter((l) => l.seq > seq && (!service || l.service === service));
  }
  get last() {
    return this.counter.n;
  }
}

export type ReadySpec = { path?: string; status?: number; log?: string; timeoutSec?: number };

export type ProcOpts = {
  name: string;
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  port?: number;
  ready?: ReadySpec;
  ring: Ring;
  redact: (s: string) => string;
  defaultTimeoutSec?: number;
};

export type Proc = {
  name: string;
  child: ChildProcess;
  pid: number;
  ready: Promise<{ ok: true } | { ok: false; error: string }>;
  exited: Promise<number | null>;
  alive: () => boolean;
  stop: (graceMs?: number) => Promise<void>;
};

export const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const killGroup = (pgid: number, sig: NodeJS.Signals) => {
  if (!pgid || pgid <= 1 || pgid === process.pid) return; // never our own group / init
  try {
    process.kill(-pgid, sig);
  } catch {
    /* gone */
  }
};

// SIGTERM the group, SIGKILL whatever is left after graceMs; resolves when the group is gone (or after kill)
export async function stopGroup(pgid: number, graceMs = 5000): Promise<void> {
  killGroup(pgid, "SIGTERM");
  for (const end = Date.now() + graceMs; Date.now() < end; ) {
    if (!groupAlive(pgid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  killGroup(pgid, "SIGKILL");
  for (const end = Date.now() + 2000; groupAlive(pgid) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 50));
}

const probe = async (url: string, status?: number): Promise<boolean> => {
  try {
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000), cache: "no-store" });
    await r.body?.cancel().catch(() => undefined);
    return status ? r.status === status : true;
  } catch {
    return false;
  }
};

export function startProc(o: ProcOpts): Proc {
  if (!fs.existsSync(o.cwd)) throw new Error(`${o.name}: cwd ${o.cwd} does not exist`);
  const child = spawn(o.file, o.args, { cwd: o.cwd, env: o.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const sys = (line: string) => o.ring.push(o.name, "sys", line);
  let exitCode: number | null | undefined;
  let logHit = false;
  const logRe = o.ready?.log ? new RegExp(o.ready.log) : null;

  const exited = new Promise<number | null>((resolve) => {
    child.once("error", (e) => {
      sys(`could not start: ${e.message}`);
      exitCode = -1;
      resolve(-1);
    });
    child.once("exit", (code, signal) => {
      exitCode = code;
      sys(`exited (${code ?? signal})`);
      resolve(code);
    });
  });

  const lineReader = (stream: "out" | "err") => {
    let buf = "";
    return (chunk: string) => {
      buf += chunk;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? "";
      if (buf.length > 8000) {
        parts.push(buf); // a runaway line without newlines
        buf = "";
      }
      for (const raw of parts) {
        const line = o.redact(raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
        if (!line.trim()) continue;
        o.ring.push(o.name, stream, line);
        if (logRe && logRe.test(raw)) logHit = true;
      }
    };
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", lineReader("out"));
  child.stderr?.on("data", lineReader("err"));

  const alive = () => exitCode === undefined;
  const timeoutMs = (o.ready?.timeoutSec ?? o.defaultTimeoutSec ?? 180) * 1000;

  const ready = (async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    const end = Date.now() + timeoutMs;
    const url = o.port && o.ready?.path ? `http://127.0.0.1:${o.port}${o.ready.path}` : null;
    const url6 = o.port && o.ready?.path ? `http://[::1]:${o.port}${o.ready.path}` : null;
    const t0 = Date.now();
    while (Date.now() < end) {
      if (!alive()) return { ok: false, error: `exited (${exitCode}) before it was ready` };
      if (logRe && logHit) return { ok: true };
      if (url && ((await probe(url, o.ready?.status)) || (await probe(url6!, o.ready?.status)))) return { ok: true };
      // no readiness rule: alive for 2s counts
      if (!url && !logRe && Date.now() - t0 > 2000) return { ok: true };
      await new Promise((r) => setTimeout(r, 700));
    }
    return { ok: false, error: `not ready after ${Math.round(timeoutMs / 1000)}s` };
  })();

  const pid = child.pid ?? 0;
  return {
    name: o.name,
    child,
    pid,
    ready,
    exited,
    alive,
    stop: async (graceMs = 5000) => {
      if (!pid) return;
      await stopGroup(pid, graceMs);
      if (alive()) await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
    },
  };
}
