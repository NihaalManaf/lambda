import path from "node:path";
import { describe, expect, it } from "vitest";
import { featureDirName, parseBase, removableFeatureDir, shouldFetch, validBaseBranch } from "./baseref";

describe("baseBranch", () => {
  it("only accepts ref names git can't read as an option, range or reflog", () => {
    for (const ok of ["origin/main", "upstream/release/2.1", "main", "feature/x", "v1.2"]) expect(validBaseBranch(ok)).toBe(true);
    for (const bad of ["", "-x", "--upload-pack=sh", "a..b", "main@{1}", "a//b", "origin/", "x.lock", "origin/-x", "a b", "a;b", "~1"])
      expect(validBaseBranch(bad)).toBe(false);
  });

  it("splits remote/branch only when the prefix is a real remote", () => {
    expect(parseBase("origin/release/2", ["origin"])).toEqual({ kind: "remote", remote: "origin", branch: "release/2", name: "origin/release/2" });
    expect(parseBase("feature/x", ["origin"])).toEqual({ kind: "local", name: "feature/x" });
    expect(parseBase("main", ["origin"])).toEqual({ kind: "local", name: "main" });
    expect(parseBase("origin/x", [])).toEqual({ kind: "local", name: "origin/x" });
    expect(parseBase("--all", ["origin"])).toBeNull();
  });
});

describe("feature worktree dirs", () => {
  const W = path.join("/data", "worktrees");
  const shared = path.join(W, "abcdef0123");
  it("sits next to the shared checkout, clear of stack's branch checkouts", () => {
    expect(featureDirName(shared, "feat_Ab-9_x")).toBe(`${shared}-f-feat_Ab-9_x`);
    expect(() => featureDirName(shared, "../x")).toThrow();
    expect(() => featureDirName(shared, "a/b")).toThrow();
  });
  it("removes only per-feature dirs directly inside the worktrees dir", () => {
    expect(removableFeatureDir(`${shared}-f-feat_1`, W, shared)).toBe(true);
    expect(removableFeatureDir(shared, W, shared)).toBe(false);
    expect(removableFeatureDir(`${shared}-a1b2c3`, W, shared)).toBe(false);
    expect(removableFeatureDir(path.join("/elsewhere", "x-f-feat_1"), W, shared)).toBe(false);
    expect(removableFeatureDir(path.join(W, "nested", "x-f-feat_1"), W, shared)).toBe(false);
  });
});

describe("fetch throttle", () => {
  it("fetches once per minute per repo + ref", () => {
    const m = new Map<string, number>();
    expect(shouldFetch(m, "k", 1000)).toBe(true);
    m.set("k", 1000);
    expect(shouldFetch(m, "k", 30_000)).toBe(false);
    expect(shouldFetch(m, "other", 30_000)).toBe(true);
    expect(shouldFetch(m, "k", 61_000)).toBe(true);
  });
});
