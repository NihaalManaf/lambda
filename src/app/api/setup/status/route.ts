import { NextResponse } from "next/server";
import { status } from "@/lib/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET → {configured, missing[], recommended[]}. configured = repo set + anthropic key resolvable + claude logged in.
export async function GET() {
  return NextResponse.json(await status());
}
