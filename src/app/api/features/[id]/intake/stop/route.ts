import { NextResponse } from "next/server";
import { stopIntake } from "@/lib/intake";
import { getFeature } from "@/lib/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// POST -> { stopped } (the running turn persists itself as "stopped")
export async function POST(_: Request, { params }: Ctx) {
  const fid = (await params).id;
  if (!getFeature(fid)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ stopped: stopIntake(fid) });
}
