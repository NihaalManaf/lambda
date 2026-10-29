import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { GET as head } from "@/app/api/schema/route";
import { GET as migration } from "@/app/api/schema/migrations/[mid]/route";
import { GET as table } from "@/app/api/schema/tables/[name]/route";
import { DELETE as del, POST as propose } from "@/app/api/features/[id]/schema/route";
import { GET as preview } from "@/app/api/features/[id]/schema/[pid]/route";
import { createFeature, getSettings } from "@/lib/store";
import type { FeatureView } from "@/lib/types";
import type { MigrationView, SchemaHead } from "./types";

const REPO = getSettings().repoPath;
const ctx = <T,>(p: T) => ({ params: Promise.resolve(p) });
const json = (body: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(body) });

describe.skipIf(!fs.existsSync(`${REPO}/migrations`))("schema routes", () => {
  it("head, migration (+sql), table", async () => {
    const h = (await (await head()).json()) as SchemaHead;
    expect(h.stats.parseErrors).toBe(0);
    const id = "20260915220000_refund_requests.sql";
    const v = (await (await migration(new Request(`http://x?sql=1`), ctx({ mid: id }))).json()) as MigrationView;
    expect(v.meta.id).toBe(id);
    expect(v.sql).toContain("refund_requests");
    expect((await migration(new Request("http://x"), ctx({ mid: "nope.sql" }))).status).toBe(404);
    const t = await (await table(new Request("http://x"), ctx({ name: "public.refund_requests" }))).json();
    expect(t.history).toEqual([id]);
  });

  it("sql proposal: create, preview, delete", async () => {
    const f = await createFeature("refunds v2", "let staff partially refund");
    const res = await propose(json({ source: "sql", sql: "alter table public.refund_requests add column partial boolean not null; drop table public.team;" }), ctx({ id: f.id }));
    const nf = (await res.json()) as FeatureView;
    const p = nf.schema![0];
    expect(p.source).toBe("sql");
    const v = (await (await preview(new Request("http://x"), ctx({ id: f.id, pid: p.id }))).json()) as MigrationView & { stale: boolean };
    expect(v.stale).toBe(false);
    expect(v.graph.risks.map((r) => r.rule)).toEqual(expect.arrayContaining(["drop-table", "not-null-fails"]));
    expect(v.graph.tables.find((t) => t.id === "public.team")?.diff).toBe("removed");
    expect(v.sql).toContain("partial");
    const bad = await propose(json({ source: "sql", sql: "alter tabel x" }), ctx({ id: f.id }));
    expect(bad.status).toBe(502);
    const after = (await (await del(new Request(`http://x?pid=${p.id}`, { method: "DELETE" }), ctx({ id: f.id }))).json()) as FeatureView;
    expect(after.schema).toEqual([]);
  });
});
