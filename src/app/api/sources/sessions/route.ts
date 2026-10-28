import { NextResponse } from "next/server";
import { listSessions } from "@/lib/sources/sessions";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? undefined;
  return NextResponse.json({ items: listSessions({ q, limit: 100 }), connected: true });
}
