import "server-only";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Which checkout is actually serving the app URL? A dev server for some *other* repo on the same port
// (common: several projects all default to :3000) makes sketches + browser checks hit the wrong app.

const run = (cmd: string, args: string[], cwd?: string) =>
  new Promise<string>((resolve) =>
    execFile(cmd, args, { timeout: 2500, cwd }, (err, stdout) => resolve(err ? "" : String(stdout).trim())),
  );

const gitCommonDir = async (dir: string) => {
  const out = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], dir);
  return out ? fs.realpathSync.native(out) : null;
};

// cwd of the process listening on the url's port (local urls only; null when unknown)
export async function servingDir(url: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return null;
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const pid = (await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])).split("\n")[0];
  if (!/^\d+$/.test(pid)) return null;
  const cwd = (await run("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"])).split("\n").find((l) => l.startsWith("n"));
  return cwd ? cwd.slice(1) : null;
}

// null = fine or unknowable; otherwise a one-line reason the app url belongs to another repo
export async function wrongApp(url: string, repoPath: string): Promise<string | null> {
  if (!repoPath) return null;
  const dir = await servingDir(url);
  if (!dir) return null;
  const [a, b] = await Promise.all([gitCommonDir(dir), gitCommonDir(repoPath)]);
  if (a && b ? a === b : dir.startsWith(path.resolve(repoPath))) return null;
  const host = new URL(url).host;
  return `${host} is serving ${path.basename(path.dirname(dir))}/${path.basename(dir)}, not ${path.basename(repoPath)}`;
}
