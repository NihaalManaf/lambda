import { NextResponse } from "next/server";
import { getLambdaMd, saveLambdaMd } from "@/lib/lambdamd";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(getLambdaMd());
}

// {text: string} saves, {text: null} resets to the default
export async function PUT(req: Request) {
  const body = (await req.json()) as { text?: unknown };
  if (body.text !== null && typeof body.text !== "string")
    return NextResponse.json({ error: "text must be a string or null" }, { status: 400 });
  saveLambdaMd(body.text);
  return NextResponse.json(getLambdaMd());
}
