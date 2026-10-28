import { NextResponse } from "next/server";
import { getMigrationView } from "@/lib/schema/replay";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ mid: string }> };

// GET ?sql=1 -> MigrationView (raw file only when asked: it's behind the </> toggle)
export async function GET(req: Request, { params }: Ctx) {
  const mid = decodeURIComponent((await params).mid);
  const sql = new URL(req.url).searchParams.get("sql") === "1";
  try {
    const v = await getMigrationView(mid, sql);
    return v ? NextResponse.json(v) : NextResponse.json({ error: "not found" }, { status: 404 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "replay failed" }, { status: 500 });
  }
}
