// Uncommitted .sql files in the migration dirs: candidates for a "from repo" proposal.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface GitFile { file: string /* repo-rel */; status: "new" | "modified" }

export async function changedSql(repo: string, dirs: string[]): Promise<GitFile[]> {
  if (!dirs.length) return [];
  const { stdout } = await run("git", ["-C", repo, "status", "--porcelain", "--untracked-files=all", "--", ...dirs], { maxBuffer: 4 << 20 });
  const out: GitFile[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    let file = line.slice(3).trim();
    if (file.includes(" -> ")) file = file.split(" -> ")[1];
    file = file.replace(/^"(.*)"$/, "$1");
    if (!file.endsWith(".sql") || code.includes("D")) continue;
    out.push({ file, status: code === "??" || code.includes("A") || code.includes("R") ? "new" : "modified" });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
