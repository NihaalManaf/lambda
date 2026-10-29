import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { claudeArgs, defaultBranch, prepareWorktree, worktreeDirFor } from "./intake";

// The lambda-owned worktree: created from main, refreshed to main's tip, and the user's checkout
// (branch, HEAD, working tree) never moves.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lambda-intake-"));
const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmp, "repo-")));
const g = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

g("init", "-q", "-b", "main");
g("config", "user.email", "t@example.com");
g("config", "user.name", "t");
fs.writeFileSync(path.join(repo, "a.txt"), "main 1\n");
g("add", ".");
g("commit", "-qm", "one");
g("checkout", "-qb", "feature-x");
fs.writeFileSync(path.join(repo, "a.txt"), "feature\n");
g("commit", "-qam", "feat");
fs.writeFileSync(path.join(repo, "dirty.txt"), "uncommitted\n"); // the user's WIP

afterAll(() => {
  try {
    g("worktree", "remove", "--force", worktreeDirFor(repo));
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("intake worktree", () => {
  it("finds main", async () => {
    expect(await defaultBranch(repo)).toEqual({ ref: "refs/heads/main", name: "main" });
  });

  it("checks out main detached without touching the user's checkout", async () => {
    const before = { branch: g("branch", "--show-current"), status: g("status", "--porcelain"), head: g("rev-parse", "HEAD") };
    const wt = await prepareWorktree(repo, true);
    if ("reason" in wt) throw new Error(wt.reason);
    expect(wt.branch).toBe("main");
    expect(wt.sha).toBe(g("rev-parse", "main"));
    expect(fs.readFileSync(path.join(wt.dir, "a.txt"), "utf8")).toBe("main 1\n");
    expect(fs.existsSync(path.join(wt.dir, "dirty.txt"))).toBe(false);
    expect({ branch: g("branch", "--show-current"), status: g("status", "--porcelain"), head: g("rev-parse", "HEAD") }).toEqual(before);

    // main moves on (without switching the user's branch) → refresh follows it; no refresh → stays put
    const tip = execFileSync("git", ["-C", repo, "commit-tree", "main^{tree}", "-p", "main", "-m", "two"], { encoding: "utf8" }).trim();
    g("update-ref", "refs/heads/main", tip);
    // no refresh: the sha reported is what the checkout really holds, not main's new tip
    expect(await prepareWorktree(repo, false)).toMatchObject({ dir: wt.dir, sha: wt.sha });
    expect(execFileSync("git", ["-C", wt.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(wt.sha);
    await prepareWorktree(repo, true);
    expect(execFileSync("git", ["-C", wt.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(tip);
    expect({ branch: g("branch", "--show-current"), status: g("status", "--porcelain"), head: g("rev-parse", "HEAD") }).toEqual(before);
  });

  it("recreates a worktree whose dir was deleted by hand", async () => {
    const dir = worktreeDirFor(repo);
    fs.rmSync(dir, { recursive: true, force: true });
    const wt = await prepareWorktree(repo, true);
    expect(wt.dir).toBe(dir);
    expect(fs.existsSync(path.join(dir, "a.txt"))).toBe(true);
  });

  it("no repo → works without a codebase", async () => {
    expect(await prepareWorktree("", true)).toEqual({ dir: null, reason: "no repo configured" });
    expect(await prepareWorktree(path.join(tmp, "nope"), true)).toEqual({ dir: null, reason: "repo path not found" });
    const plain = fs.mkdtempSync(path.join(tmp, "plain-"));
    expect((await prepareWorktree(plain, true)).dir).toBeNull();
  });
});

describe("intake claude args", () => {
  it("sandboxes the session: read-only tools, no MCP servers, no project settings", () => {
    const a = claudeArgs("hi", { id: "00000000-0000-4000-8000-000000000000", resume: false });
    expect(a).toContain("--strict-mcp-config");
    expect(a[a.indexOf("--mcp-config") + 1]).toBe(JSON.stringify({ mcpServers: {} }));
    expect(a[a.indexOf("--setting-sources") + 1]).toBe("user");
    expect(a.slice(a.indexOf("--tools") + 1)).toEqual(["Read", "Grep", "Glob"]);
    expect(a).not.toContain("--max-budget-usd");
  });
  it("code questions get a tighter budget", () => {
    const a = claudeArgs("q", { id: "s", resume: true }, { maxTurns: 12, timeoutMs: 1, budgetUsd: 0.75 });
    expect(a[a.indexOf("--max-turns") + 1]).toBe("12");
    expect(a[a.indexOf("--max-budget-usd") + 1]).toBe("0.75");
    expect(a[a.indexOf("--resume") + 1]).toBe("s");
  });
});
