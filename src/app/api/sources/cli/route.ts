import { NextResponse } from "next/server";
import { detectCli } from "@/lib/sources/cli";

export async function GET() {
  return NextResponse.json({ items: await detectCli(), connected: true });
}
