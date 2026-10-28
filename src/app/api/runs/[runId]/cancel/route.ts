import { NextResponse } from "next/server";
import { cancelRun } from "@/lib/verify";

type Ctx = { params: Promise<{ runId: string }> };

export async function POST(_: Request, { params }: Ctx) {
  const ok = cancelRun((await params).runId);
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
}
