import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { changedSql } from "./git";

describe("git", () => {
  it("lists new + modified .sql in the migration dirs only", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gitmig-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
    git("init", "-q");
    fs.mkdirSync(path.join(repo, "migrations"));
    fs.writeFileSync(path.join(repo, "migrations", "1_a.sql"), "select 1;");
    git("add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x");
    fs.writeFileSync(path.join(repo, "migrations", "1_a.sql"), "select 2;");
    fs.writeFileSync(path.join(repo, "migrations", "2_b.sql"), "select 3;");
    fs.writeFileSync(path.join(repo, "migrations", "notes.md"), "");
    fs.writeFileSync(path.join(repo, "other.sql"), "");
    expect(await changedSql(repo, ["migrations"])).toEqual([
      { file: "migrations/1_a.sql", status: "modified" },
      { file: "migrations/2_b.sql", status: "new" },
    ]);
  });
});
