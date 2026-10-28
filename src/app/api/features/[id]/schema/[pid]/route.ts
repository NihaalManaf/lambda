import { NextResponse } from "next/server";
import { opsToSql } from "@/lib/schema/emit";
import { current, previewOps } from "@/lib/schema/replay";
import { getFeature } from "@/lib/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; pid: string }> };

// GET -> MigrationView & {stale}: the proposal's ops applied to the current head
export async function GET(_req: Request, { params }: Ctx) {
  const { id, pid } = await params;
  const f = getFeature(id);
  const p = f?.schema?.find((x) => x.id === pid);
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const r = await current();
    const meta = {
      id: p.id, file: p.files?.[0] ?? "", order: r.files.length, date: p.createdAt.slice(0, 10), title: p.title,
      magnitude: Math.max(1, p.ops.length), worst: null, tables: [], dupPrefix: false, dynamic: p.ops.filter((o) => o.op === "dynamic").length,
    };
    const v = previewOps(r, p.ops, meta, p.source === "git" ? p.files : []);
    return NextResponse.json({ ...v, sql: p.sql ?? opsToSql(p.ops, r.head), stale: p.baseSig !== r.sig });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "preview failed" }, { status: 500 });
  }
}
