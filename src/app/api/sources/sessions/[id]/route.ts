import { NextResponse } from "next/server";
import { getSessionDigest } from "@/lib/sources/sessions";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const d = getSessionDigest((await params).id);
  return d ? NextResponse.json(d) : NextResponse.json({ error: "not found" }, { status: 404 });
}
