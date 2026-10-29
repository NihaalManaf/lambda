import { NextResponse } from "next/server";
import { detect } from "@/lib/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST → tools + ranked repos + (if one clearly dominates) its detection + the plan. No secret values.
export async function POST() {
  return NextResponse.json(await detect());
}
