import { NextResponse } from "next/server";
import { linearIssues } from "@/lib/sources/linear";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? undefined;
  return NextResponse.json(await linearIssues(q));
}
