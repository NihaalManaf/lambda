import { NextResponse } from "next/server";
import { getFeature, id, updateFeature } from "@/lib/store";
import type { ContextRef } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

const KINDS: ContextRef["kind"][] = ["slack", "linear", "session", "note"];
const cut = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);

// Attach a context ref. Excerpt is capped: context is a pointer, not a transcript.
export async function POST(req: Request, { params }: Ctx) {
  const featureId = (await params).id;
  if (!getFeature(featureId)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Partial<ContextRef>;
  if (!body.kind || !KINDS.includes(body.kind)) return NextResponse.json({ error: "bad kind" }, { status: 400 });
  const title = cut(body.title, 140);
  if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });
  const ref: ContextRef = {
    id: body.id && /^[\w-]{4,80}$/.test(body.id) ? body.id : id("ctx"),
    kind: body.kind,
    title,
    excerpt: cut(body.excerpt, 400),
    ...(body.url && /^https?:\/\//.test(body.url) ? { url: cut(body.url, 500) } : {}),
  };
  const f = await updateFeature(featureId, (f) => {
    if (!f.context.some((c) => c.id === ref.id)) f.context.push(ref);
  });
  return NextResponse.json(f);
}

export async function DELETE(req: Request, { params }: Ctx) {
  const featureId = (await params).id;
  const refId = new URL(req.url).searchParams.get("refId");
  if (!getFeature(featureId)) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!refId) return NextResponse.json({ error: "refId required" }, { status: 400 });
  const f = await updateFeature(featureId, (f) => {
    f.context = f.context.filter((c) => c.id !== refId);
  });
  return NextResponse.json(f);
}
