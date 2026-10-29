import { NextResponse } from "next/server";
import { proposeFromGit, proposeFromPrompt, proposeFromSql } from "@/lib/schema/propose";
import { findPiece, pieceIdFrom, pieceOfSchema, pieceView, withPiece } from "@/lib/pieces";
import { getFeature, updateFeature } from "@/lib/store";
import { featureMode } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };
const err = (error: string, status = 400) => NextResponse.json({ error }, { status });

// POST {source:"llm", prompt} | {source:"sql", sql, name?} | {source:"git", files} -> pieceView (body.pieceId / ?piece=; default: first piece)
export async function POST(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const b = (await req.json().catch(() => ({}))) as { source?: string; prompt?: string; sql?: string; name?: string; files?: unknown; pieceId?: string };
  const pid = pieceIdFrom(req.url, b);
  const stored = getFeature(fid);
  if (!stored) return err("not found", 404);
  // a proposal diffs a change: nothing to propose when explaining an existing feature
  if (featureMode(stored) === "understand") return err("proposals are build-only (this feature is in understand mode)", 409);
  if (pid && !findPiece(stored, pid)) return err("piece not found", 404);
  const feature = pieceView(stored, pid);
  try {
    const p =
      b.source === "llm" && b.prompt?.trim() ? await proposeFromPrompt(feature, b.prompt.trim().slice(0, 4000))
      : b.source === "sql" && b.sql?.trim() ? await proposeFromSql(b.sql.slice(0, 500_000), b.name?.slice(0, 200))
      : b.source === "git" && Array.isArray(b.files) && b.files.length ? await proposeFromGit(b.files.filter((f): f is string => typeof f === "string"))
      : null;
    if (!p) return err("need {source:llm,prompt} | {source:sql,sql} | {source:git,files}");
    const f = await updateFeature(fid, (f) => withPiece(f, pid, (v) => void (v.schema = [...(v.schema ?? []), p])));
    return NextResponse.json(pieceView(f, pid));
  } catch (e) {
    return err(e instanceof Error ? e.message : "proposal failed", 502);
  }
}

// DELETE ?pid= -> pieceView (body.pieceId / ?piece=; default: first piece)
export async function DELETE(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const pid = new URL(req.url).searchParams.get("pid");
  if (!pid) return err("pid required");
  try {
    let piece = pieceIdFrom(req.url);
    const f = await updateFeature(fid, (f) => {
      const owner = pieceOfSchema(f, pid);
      if (!owner) return;
      piece = owner.id;
      owner.schema = (owner.schema ?? []).filter((p) => p.id !== pid);
    });
    return NextResponse.json(pieceView(f, piece));
  } catch (e) {
    return err(e instanceof Error ? e.message : "delete failed", 404);
  }
}
