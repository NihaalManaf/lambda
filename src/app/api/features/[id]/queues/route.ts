import { NextResponse } from "next/server";
import { proposeFromGit, proposeFromPrompt } from "@/lib/queues/propose";
import { getFeature, updateFeature } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };
const err = (error: string, status = 400) => NextResponse.json({ error }, { status });

// POST {source:"llm", prompt} | {source:"git"} -> Feature
export async function POST(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const b = (await req.json().catch(() => ({}))) as { source?: string; prompt?: string };
  const feature = getFeature(fid);
  if (!feature) return err("not found", 404);
  try {
    const p =
      b.source === "llm" && b.prompt?.trim() ? await proposeFromPrompt(feature, b.prompt.trim().slice(0, 4000))
      : b.source === "git" ? await proposeFromGit()
      : null;
    if (!p) return err("need {source:llm,prompt} | {source:git}");
    return NextResponse.json(await updateFeature(fid, (f) => void (f.queues = [...(f.queues ?? []), p])));
  } catch (e) {
    return err(e instanceof Error ? e.message : "proposal failed", 502);
  }
}

// DELETE ?pid= -> Feature
export async function DELETE(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const pid = new URL(req.url).searchParams.get("pid");
  if (!pid) return err("pid required");
  try {
    return NextResponse.json(await updateFeature(fid, (f) => void (f.queues = (f.queues ?? []).filter((p) => p.id !== pid))));
  } catch (e) {
    return err(e instanceof Error ? e.message : "delete failed", 404);
  }
}
