import { NextResponse } from "next/server";
import { getHead } from "@/lib/schema/replay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET -> SchemaHead (migration ticks + table tiles; per-migration views load lazily)
export async function GET() {
  try {
    return NextResponse.json(await getHead());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "replay failed" }, { status: 500 });
  }
}
