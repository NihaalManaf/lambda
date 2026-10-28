// LLM normalization with the model mocked: fills only gaps, cached by content hash.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const generate = vi.fn(async () => ({
  publishes: [{ symbol: "kick", line: 2, channelKey: "/work" }],
  consumers: [{ symbol: "work", line: 4, route: "/work", idempotency: "lock", retryAware: true, nonRetryable: false }],
}));
vi.mock("../llm", () => ({ generate }));
vi.mock("../env", () => ({ secret: () => "test-key" }));

const { normalize } = await import("./normalize");
const { link } = await import("./link");
import type { RawScan } from "./types";

describe("normalize", () => {
  it("fills unresolved targets + unknown idempotency, then hits the cache", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "lambda-q-repo-"));
    fs.mkdirSync(path.join(repo, "api"), { recursive: true });
    fs.writeFileSync(path.join(repo, "api/w.py"), `def kick():\n    client.message.publish_json(url=build())\n\ndef work():\n    pass\n# ${Math.random()}\n`); // fresh hash per run
    const raw: RawScan = {
      sites: [{ file: "api/w.py", line: 2, end: 2, fn: "kick", lang: "py", call: "publish_json", kw: { url: "{build}", retries: 1 } }],
      routes: [{ file: "api/w.py", line: 4, fn: "work", method: "post", path: "/work", auth: "qstash-sig", marks: [], reach: [] }],
      crons: [], lambdas: [], queues: [], esm: [], rules: [], gh: [], deps: [], queueEnv: [], envs: {}, files: [], engine: "python",
    };
    const before = link(raw);
    expect(before.channels.some((c) => c.key.startsWith("?"))).toBe(true);
    const progress: number[] = [];
    const norm = await normalize(raw, { ...before, domains: [], risks: [], sig: "", scannedAt: "", files: 0 }, repo, (d) => progress.push(d));
    const after = link(raw, norm);
    expect(after.channels.map((c) => c.key)).toContain("/work");
    expect(after.consumers.find((k) => k.route === "/work")).toMatchObject({ idempotency: "lock", retryAware: true });
    expect(after.edges.some((e) => e.to === "c:qstash-url:/work" && e.opts?.retries === 1)).toBe(true); // deterministic opts kept
    expect(generate).toHaveBeenCalledTimes(1);
    await normalize(raw, { ...before, domains: [], risks: [], sig: "", scannedAt: "", files: 0 }, repo, () => {});
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
