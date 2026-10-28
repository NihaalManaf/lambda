import { NextResponse } from "next/server";
import { proposeFromGit, proposeFromPrompt, proposeFromSql } from "@/lib/schema/propose";
import { getFeature, updateFeature } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };
const err = (error: string, status = 400) => NextResponse.json({ error }, { status });

// POST {source:"llm", prompt} | {source:"sql", sql, name?} | {source:"git", files} -> Feature
export async function POST(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const b = (await req.json().catch(() => ({}))) as { source?: string; prompt?: string; sql?: string; name?: string; files?: unknown };
  const feature = getFeature(fid);
  if (!feature) return err("not found", 404);
  try {
    const p =
      b.source === "llm" && b.prompt?.trim() ? await proposeFromPrompt(feature, b.prompt.trim().slice(0, 4000))
      : b.source === "sql" && b.sql?.trim() ? await proposeFromSql(b.sql.slice(0, 500_000), b.name?.slice(0, 200))
      : b.source === "git" && Array.isArray(b.files) && b.files.length ? await proposeFromGit(b.files.filter((f): f is string => typeof f === "string"))
      : null;
    if (!p) return err("need {source:llm,prompt} | {source:sql,sql} | {source:git,files}");
    return NextResponse.json(await updateFeature(fid, (f) => void (f.schema = [...(f.schema ?? []), p])));
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
    return NextResponse.json(await updateFeature(fid, (f) => void (f.schema = (f.schema ?? []).filter((p) => p.id !== pid))));
  } catch (e) {
    return err(e instanceof Error ? e.message : "delete failed", 404);
  }
}
