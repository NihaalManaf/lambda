import { NextResponse } from "next/server";
import { detectChosen } from "@/lib/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST {path} → detection + plan for the repo the user picked. Path: absolute, existing, inside $HOME.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { path?: unknown };
  const out = await detectChosen(body.path);
  return out ? NextResponse.json(out) : NextResponse.json({ error: "path must be an existing folder inside your home folder" }, { status: 400 });
}
