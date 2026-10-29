import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { removeAgentState, writeAgentState } from "./agentstate";
import { claudeArgs } from "./intake";
import { makePiece } from "./pieces";
import { createFeature, getFeature, SHOTS_DIR, updateFeature } from "./store";

describe("agent state", () => {
  it("writes every piece's artifacts with absolute screenshot paths, and is removed with the feature", async () => {
    const f0 = await createFeature("invites", "");
    const f = await updateFeature(f0.id, (x) => {
      const p = makePiece({ title: "invite flow", order: 1 });
      p.mockups = [{ id: "mk_1", url: "/invites", title: "invites", shot: "s1.png", width: 10, height: 10, elements: [], annotations: [], createdAt: "" }];
      p.runs = [{ id: "run_1", storyId: "st_1", status: "failed", startedAt: "", log: ["x"], shots: ["01.png", "../evil.png"] }];
      x.pieces = [p];
      x.jobs = [{ kind: "sketch", status: "done", note: "skipped /invites — login failed" } as never];
    });
    const dir = writeAgentState(getFeature(f.id)!);
    const files = fs.readdirSync(dir).sort();
    expect(files).toContain("README.md");
    expect(files).toContain("feature.json");
    const piece = JSON.parse(fs.readFileSync(path.join(dir, files.find((n) => n.startsWith("piece-"))!), "utf8"));
    expect(piece.mockups[0].screenshot).toBe(path.join(SHOTS_DIR, "s1.png"));
    expect(piece.mockups[0].elements).toBeUndefined();
    expect(piece.runs[0].shots).toEqual([path.join(SHOTS_DIR, "run_1", "01.png")]);
    expect(piece.jobs.some((j: { note?: string }) => j.note?.includes("login failed"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "feature.json"), "utf8")).chat).toBeUndefined();
    removeAgentState(f.id);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("carries piece facts + check, rewrites in place without wiping, drops a removed piece's file", async () => {
    const f0 = await createFeature("grounded", "");
    const [a, b] = [makePiece({ title: "one", order: 1 }), makePiece({ title: "two", order: 2 })];
    a.facts = { routes: [{ path: "/media-database", screen: "list", labels: ["Add media"], file: "a.tsx:1" }], endpoints: [], tables: ["media"], gates: [], components: [], notes: [], appRoutes: ["/media-database"], sha: "abcdef1234", at: "" };
    a.check = { ok: 3, fixed: 1, flagged: 0, at: "" };
    await updateFeature(f0.id, (x) => void (x.pieces = [a, b]));
    const dir = writeAgentState(getFeature(f0.id)!);
    const file = (n: string) => fs.readdirSync(dir).find((x) => x.startsWith(`piece-${n}-`))!;
    const one = JSON.parse(fs.readFileSync(path.join(dir, file("1")), "utf8"));
    expect(one.facts.routes[0].labels).toEqual(["Add media"]);
    expect(one.check.fixed).toBe(1);
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toContain("facts: 1 routes / 0 endpoints (sha abcdef1)");
    const marker = path.join(dir, "notes-by-a-session.txt"); // not lambda's: survives a rewrite
    fs.writeFileSync(marker, "x");
    await updateFeature(f0.id, (x) => void (x.pieces = [x.pieces[0]]));
    writeAgentState(getFeature(f0.id)!);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith("piece-"))).toHaveLength(1);
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readdirSync(dir).some((n) => n.endsWith(".tmp"))).toBe(false);
    removeAgentState(f0.id);
  });

  it("points the session at the state dir and the shots", () => {
    const a = claudeArgs("hi", { id: "s", resume: false }, undefined, "build", "/tmp/state/f1");
    expect(a.slice(a.indexOf("--add-dir") + 1, a.indexOf("--add-dir") + 3)).toEqual(["/tmp/state/f1", SHOTS_DIR]);
    expect(a[a.indexOf("--append-system-prompt") + 1]).toContain("/tmp/state/f1");
    expect(claudeArgs("hi", { id: "s", resume: false })).not.toContain("--add-dir");
  });
});
