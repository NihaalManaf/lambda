import { NextResponse } from "next/server";
import { getTableView } from "@/lib/schema/replay";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ name: string }> };

// GET -> {graph, history}: one table at head + its FK neighbours, and the migrations that touched it
export async function GET(_req: Request, { params }: Ctx) {
  const name = decodeURIComponent((await params).name);
  try {
    const v = await getTableView(name);
    return v ? NextResponse.json(v) : NextResponse.json({ error: "not found" }, { status: 404 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "replay failed" }, { status: 500 });
  }
}
