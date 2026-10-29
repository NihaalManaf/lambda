import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFacts, runVerifier } from "./grounding";
import { codeSession, type ClaudeOut } from "./intake";
import { makePiece, pieceView } from "./pieces";
import { createFeature, updateFeature } from "./store";
import type { FeatureView } from "./types";

// the session orchestration around the facts / check blocks, with the checkout and claude stubbed (no real
// session): first reply valid, one re-ask, salvage only on the final parse, failures keep the route scan

const real = { ...codeSession };
const fence = (kind: string, body: string) => "```lambda-" + kind + "\n" + body + "\n```";
const FACTS = { routes: [{ path: "/media-database", screen: "media list", labels: ["Add media"], file: "a.tsx:3" }], tables: ["media"] };

let dir = "";
let view: FeatureView;
const calls: { prompt: string; resume: boolean }[] = [];

// replies in order; an Error rejects that run
function stub(replies: (string | Error | ClaudeOut)[]) {
  calls.length = 0;
  codeSession.worktreeForFeature = (async () => ({ dir, sha: "abcdef1234567", branch: "main" })) as typeof codeSession.worktreeForFeature;
  codeSession.runClaude = (async (o: { prompt: string; session: { resume: boolean } }) => {
    calls.push({ prompt: o.prompt, resume: o.session.resume });
    const r = replies.shift();
    if (r instanceof Error) throw r;
    if (typeof r === "string") return { ok: true, text: r, all: r };
    return r ?? { ok: false, text: "", all: "", error: "no reply" };
  }) as typeof codeSession.runClaude;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lambda-grounding-"));
  for (const f of ["src/app/page.tsx", "src/app/media-database/page.tsx"]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), "export default function P() {}\n");
  }
  const f0 = await createFeature("grounding", "browse media", "shaping");
  const p = makePiece({ id: "pc_g", title: "media list", order: 1 });
  const f = await updateFeature(f0.id, (f) => void (f.pieces = [p]));
  view = pieceView(f, "pc_g");
});

afterEach(() => Object.assign(codeSession, real));

describe("readFacts", () => {
  it("a valid block on the first reply: no re-ask, routes scanned from the checkout", async () => {
    stub([`read it.\n${fence("facts", JSON.stringify(FACTS))}`]);
    const r = await readFacts(view);
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("/media-database  (src/app/media-database/page.tsx)");
    expect(r.error).toBeUndefined();
    expect(r.facts).toMatchObject({ tables: ["media"], appRoutes: ["/", "/media-database"], sha: "abcdef1234567" });
    expect(r.facts.incomplete).toBeUndefined();
  });

  it("an invalid block is re-asked once on the same session", async () => {
    stub([fence("facts", "{not json"), fence("facts", JSON.stringify(FACTS))]);
    const r = await readFacts(view);
    expect(calls.map((c) => c.resume)).toEqual([false, true]);
    expect(calls[1].prompt).toMatch(/didn't validate/);
    expect(r.facts.routes[0].path).toBe("/media-database");
  });

  it("salvage only on the final parse: a half-valid block is re-asked first, then its valid items kept", async () => {
    const half = fence("facts", JSON.stringify({ ...FACTS, gates: [{ what: "owners only" }] })); // gate without a cite
    stub([half, half]);
    const r = await readFacts(view);
    expect(calls).toHaveLength(2);
    expect(r.error).toBeUndefined();
    expect(r.facts).toMatchObject({ tables: ["media"], gates: [] });
    expect(r.facts.routes).toHaveLength(1);
  });

  it("a failed session keeps the route scan, marked incomplete", async () => {
    stub([fence("facts", "nope"), fence("facts", "still nope")]);
    const r = await readFacts(view);
    expect(r.error).toMatch(/not valid JSON/);
    expect(r.facts).toMatchObject({ routes: [], appRoutes: ["/", "/media-database"], sha: "abcdef1234567" });
    expect(r.facts.incomplete).toMatch(/not valid JSON/);
  });

  it("no checkout → skipped, nothing read", async () => {
    stub([]);
    codeSession.worktreeForFeature = (async () => ({ dir: null, reason: "no repo set" })) as typeof codeSession.worktreeForFeature;
    const r = await readFacts(view);
    expect(r.skipped).toBe("no repo set");
    expect(calls).toHaveLength(0);
    expect(r.facts.incomplete).toBe("no repo set");
  });
});

describe("runVerifier", () => {
  it("parses verdicts (one sloppy item dropped) with the scanned routes; a bad block is re-asked once, then throws", async () => {
    const ok = { target: { kind: "story", id: "s1" }, verdict: "ok", evidence: "a.tsx:1" };
    stub([fence("check", JSON.stringify([ok, { verdict: "wrong" }]))]);
    const r = await runVerifier(view);
    expect(r.items).toHaveLength(1);
    expect(r.routes).toEqual(["/", "/media-database"]);
    expect(r.sha).toBe("abcdef1234567");

    stub([fence("check", "{oops"), "no block at all"]);
    await expect(runVerifier(view)).rejects.toThrow(/no lambda-check block/);
    expect(calls.map((c) => c.resume)).toEqual([false, true]);
  });
});
