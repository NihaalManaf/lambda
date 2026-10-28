import { NextResponse } from "next/server";
import { startScan } from "@/lib/queues/cache";

export const runtime = "nodejs";

// POST {llm?: boolean} -> ScanStatus. Runs in the background; GET /api/queues reports progress.
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { llm?: boolean };
  return NextResponse.json(startScan({ llm: b.llm !== false }));
}
