import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Readiness + identity probe for the mac app: echoes the nonce main.cjs handed this server, so the
// shell never trusts some other process that grabbed the port first.
export function GET() {
  return NextResponse.json({ ok: true, nonce: process.env.LAMBDA_NONCE ?? null });
}
