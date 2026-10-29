import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  claudeArgs,
  defaultBranch,
  featureWorktreeDirFor,
  fetchBase,
  INTAKE_PROMPT,
  prepareFeatureWorktree,
  prepareSharedWorktree,
  prepareWorktree,
  refreshFeatureWorktree,
  removeFeatureWorktree,
  resolveBase,
  UNDERSTAND_PROMPT,
  UNDERSTAND_TRAILER,
  worktreeDirFor,
  worktreeForFeature,
} from "./intake";
import { createFeature, getFeature, getSettings, saveSettings } from "./store";
import type { Feature } from "./types";

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

// A base on a remote: fetched into refs/remotes only, per-feature checkouts pinned until refresh, removed on delete.
describe("base branch on a remote", () => {
  const up = fs.realpathSync(fs.mkdtempSync(path.join(tmp, "up-")));
  const u = (...args: string[]) => execFileSync("git", ["-C", up, ...args], { encoding: "utf8" }).trim();
  u("init", "-q", "-b", "main");
  u("config", "user.email", "t@example.com");
  u("config", "user.name", "t");
  fs.writeFileSync(path.join(up, "a.txt"), "up 1\n");
  u("add", ".");
  u("commit", "-qm", "one");
  u("checkout", "-qb", "stage");
  fs.writeFileSync(path.join(up, "a.txt"), "stage 1\n");
  u("commit", "-qam", "stage one");
  const advance = (msg: string) => {
    fs.writeFileSync(path.join(up, "a.txt"), `${msg}\n`);
    u("commit", "-qam", msg);
    return u("rev-parse", "HEAD");
  };
  const user = path.join(tmp, "user");
  execFileSync("git", ["clone", "-q", up, user]);
  const top = fs.realpathSync(user);
  const c = (...args: string[]) => execFileSync("git", ["-C", top, ...args], { encoding: "utf8" }).trim();
  c("branch", "feature/x"); // a local branch with a slash
  fs.writeFileSync(path.join(top, "wip.txt"), "uncommitted\n");
  const state = () => ({ branch: c("branch", "--show-current"), status: c("status", "--porcelain"), head: c("rev-parse", "HEAD"), branches: c("branch", "--format=%(refname) %(objectname)") });
  const prev = getSettings();

  afterAll(() => {
    saveSettings({ repoPath: prev.repoPath, baseBranch: prev.baseBranch });
    for (const d of fs.readdirSync(path.dirname(worktreeDirFor(top))).filter((n) => n.startsWith(path.basename(worktreeDirFor(top)))))
      try {
        c("worktree", "remove", "--force", path.join(path.dirname(worktreeDirFor(top)), d));
      } catch {}
  });

  it("parses the setting: remote ref, local ref with a slash, auto", async () => {
    expect(await resolveBase(top, "origin/stage")).toEqual({ ref: "refs/remotes/origin/stage", name: "origin/stage", remote: "origin", branch: "stage" });
    expect(await resolveBase(top, "feature/x")).toEqual({ ref: "refs/heads/feature/x", name: "feature/x" });
    // auto = defaultBranch(): the clone's checked-out default (origin/HEAD → stage), read locally
    expect(await resolveBase(top, "")).toEqual({ ref: "refs/heads/stage", name: "stage" });
    expect(await resolveBase(top, "nope")).toBeNull();
    expect(await resolveBase(top, "--upload-pack=x")).toBeNull();
  });

  it("fetch moves only the remote-tracking ref, throttled", async () => {
    const before = state();
    const base = (await resolveBase(top, "origin/stage"))!;
    const tip = advance("stage 2");
    expect(await fetchBase(top, base)).toBeNull();
    expect(c("rev-parse", "refs/remotes/origin/stage")).toBe(tip);
    expect(fs.existsSync(path.join(top, ".git", "FETCH_HEAD"))).toBe(false);
    expect(state()).toEqual(before);
    // within the minute: skipped; forced: fetched
    const tip2 = advance("stage 3");
    expect(await fetchBase(top, base)).toBeNull();
    expect(c("rev-parse", "refs/remotes/origin/stage")).toBe(tip);
    expect(await fetchBase(top, base, true)).toBeNull();
    expect(c("rev-parse", "refs/remotes/origin/stage")).toBe(tip2);
    expect(state()).toEqual(before);
  });

  it("a failed fetch reads the last known tip, with a status line", async () => {
    c("remote", "add", "gone", path.join(tmp, "no-such-remote"));
    c("update-ref", "refs/remotes/gone/stage", c("rev-parse", "refs/remotes/origin/stage"));
    saveSettings({ repoPath: top, baseBranch: "gone/stage" });
    const wt = await prepareSharedWorktree(top, { fetch: true, move: true });
    if ("reason" in wt) throw new Error(wt.reason);
    expect(wt.sha).toBe(c("rev-parse", "refs/remotes/gone/stage"));
    expect(wt.status).toMatch(/^couldn't fetch gone\/stage .* reading last known [0-9a-f]{7}$/);
  });

  it("build: own checkout pinned at the base it started from; understand: the shared one", async () => {
    saveSettings({ repoPath: top, baseBranch: "origin/stage" });
    const before = state();
    const f = await createFeature("pin me", "");
    const wt = await prepareFeatureWorktree(top, f);
    if ("reason" in wt) throw new Error(wt.reason);
    expect(wt.dir).toBe(featureWorktreeDirFor(top, f.id));
    expect(wt.branch).toBe("origin/stage");
    const pin = wt.sha;
    expect(getFeature(f.id)?.intake).toMatchObject({ baseSha: pin, baseRef: "origin/stage" });

    // the base moves on: the feature keeps reading its pin, even recreated after a hand delete
    const tip = advance("stage 4");
    await fetchBase(top, (await resolveBase(top))!, true);
    expect(await prepareFeatureWorktree(top, getFeature(f.id)!)).toMatchObject({ sha: pin });
    fs.rmSync(wt.dir, { recursive: true, force: true });
    expect(await prepareFeatureWorktree(top, getFeature(f.id)!)).toMatchObject({ sha: pin });
    expect(execFileSync("git", ["-C", wt.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(pin);

    // mode picks the dir
    const und = { ...getFeature(f.id)!, mode: "understand" } as Feature;
    expect((await worktreeForFeature(top, und, false)).dir).toBe(worktreeDirFor(top));
    expect((await worktreeForFeature(top, getFeature(f.id)!, false)).dir).toBe(wt.dir);

    // refresh: moved to the fetched tip and re-pinned; the session starts over
    const r = await refreshFeatureWorktree(f.id);
    expect(r).toMatchObject({ sha: tip, moved: true });
    expect(getFeature(f.id)?.intake).toMatchObject({ baseSha: tip, mainSha: tip });
    expect(getFeature(f.id)?.intake?.worktree).toBeUndefined();
    expect(execFileSync("git", ["-C", wt.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(tip);

    // delete: its checkout goes, the shared one stays, the user's checkout never moved
    await removeFeatureWorktree(f.id, wt.dir);
    expect(fs.existsSync(wt.dir)).toBe(false);
    expect(c("worktree", "list")).not.toContain(wt.dir);
    expect(fs.existsSync(worktreeDirFor(top))).toBe(true);
    await removeFeatureWorktree(f.id, worktreeDirFor(top)); // an old feature's stored shared dir: never removed
    expect(fs.existsSync(worktreeDirFor(top))).toBe(true);
    expect(state()).toEqual(before);
  });

  it("an old feature without a pin gets one from the base tip", async () => {
    saveSettings({ repoPath: top, baseBranch: "origin/stage" });
    const f = await createFeature("old", "");
    const old = { ...f, intake: { status: "asking", worktree: worktreeDirFor(top), mainSha: "0".repeat(40) } } as Feature;
    const wt = await prepareFeatureWorktree(top, old);
    if ("reason" in wt) throw new Error(wt.reason);
    expect(wt.sha).toBe(c("rev-parse", "refs/remotes/origin/stage"));
    expect(getFeature(f.id)?.intake?.baseSha).toBe(wt.sha);
    await removeFeatureWorktree(f.id);
    expect(fs.existsSync(wt.dir)).toBe(false);
  });
});

describe("intake claude args", () => {
  it("runs a full session: every tool, MCP server and setting source; only AskUserQuestion is off", () => {
    const a = claudeArgs("hi", { id: "00000000-0000-4000-8000-000000000000", resume: false });
    for (const flag of ["--tools", "--strict-mcp-config", "--mcp-config", "--setting-sources"]) expect(a).not.toContain(flag);
    expect(a[a.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    expect(a.slice(a.indexOf("--disallowed-tools") + 1)).toEqual(["AskUserQuestion"]);
    expect(a).not.toContain("--max-budget-usd");
  });
  it("code questions get a tighter budget", () => {
    const a = claudeArgs("q", { id: "s", resume: true }, { maxTurns: 12, timeoutMs: 1, budgetUsd: 0.75 });
    expect(a[a.indexOf("--max-turns") + 1]).toBe("12");
    expect(a[a.indexOf("--max-budget-usd") + 1]).toBe("0.75");
    expect(a[a.indexOf("--resume") + 1]).toBe("s");
  });
  it("system prompt follows the feature mode on every run, resume included", () => {
    const sys = (a: string[]) => a[a.indexOf("--append-system-prompt") + 1];
    expect(sys(claudeArgs("hi", { id: "s", resume: false }))).toContain(INTAKE_PROMPT);
    const u = sys(claudeArgs("hi", { id: "s", resume: true }, undefined, "understand"));
    expect(u).toContain(UNDERSTAND_PROMPT);
    expect(u).not.toContain(INTAKE_PROMPT);
    // the trailer comes after lambda.md so its build / PR guidance can't win
    expect(u.endsWith(UNDERSTAND_TRAILER)).toBe(true);
    expect(sys(claudeArgs("hi", { id: "s", resume: false }))).not.toContain(UNDERSTAND_TRAILER);
    // same block protocol, so parsing keeps working
    for (const block of ["```lambda-ask", "```lambda-brief", '"pieces"', '"surfaces"']) expect(UNDERSTAND_PROMPT).toContain(block);
    expect(UNDERSTAND_PROMPT).toContain("```lambda-issue"); // understand collects issues; build intake never does
    expect(INTAKE_PROMPT).not.toContain("lambda-issue");
  });
  it("a facts / check session swaps the intake prompt for its own, keeping the state line", () => {
    const a = claudeArgs("go", { id: "s", resume: false }, { maxTurns: 30, timeoutMs: 1 }, "understand", "/tmp/state/f1", "you are lambda's code reader.");
    const sys = a[a.indexOf("--append-system-prompt") + 1];
    expect(sys.startsWith("you are lambda's code reader.")).toBe(true);
    expect(sys).not.toContain(UNDERSTAND_PROMPT);
    expect(sys).toContain("/tmp/state/f1");
    expect(sys).toContain(UNDERSTAND_TRAILER);
    expect(a.slice(a.indexOf("--add-dir") + 1, a.indexOf("--add-dir") + 2)).toEqual(["/tmp/state/f1"]);
    expect(a[a.indexOf("--max-turns") + 1]).toBe("30");
  });
});
