import { NextResponse } from "next/server";
import { slackMessages } from "@/lib/sources/slack";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? undefined;
  return NextResponse.json(await slackMessages(q));
}
