import { NextResponse } from "next/server";
import { settingsView } from "@/components/settings/view";
import { apply, SetupError, status, type ApplyBody } from "@/lib/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST {repoPath, envPath?, frontendUrl?, migrations?, appHosts?, accountCandidateId?, account?, anthropicKey?}
// Omitted fields fall back to what detection finds in repoPath. Returns the masked settings view + status.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ApplyBody | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "json body required" }, { status: 400 });
  try {
    const saved = await apply(body);
    return NextResponse.json({ settings: settingsView(saved), status: await status() });
  } catch (e) {
    if (e instanceof SetupError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
