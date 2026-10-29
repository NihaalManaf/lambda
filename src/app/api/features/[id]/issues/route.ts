import { NextResponse } from "next/server";
import { cleanIssue, deleteIssue, logIssues, patchIssue, type IssuePatch } from "@/lib/issues";
import { pieceIdFrom, pieceView } from "@/lib/pieces";
import { getFeature } from "@/lib/store";
import type { IssueKind, IssueSource } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };
const err = (error: string, status = 400) => NextResponse.json({ error }, { status });
const fail = (e: unknown) => {
  const m = e instanceof Error ? e.message : "failed";
  return err(m, /not found/.test(m) ? 404 : /understand mode/.test(m) ? 409 : 400);
};

// Understand mode's issues (src/lib/issues.ts). Every write returns the pieceView (?piece=).
export async function GET(_: Request, { params }: Ctx) {
  const f = getFeature((await params).id);
  return f ? NextResponse.json({ issues: f.issues ?? [], builds: f.builds ?? [] }) : err("not found", 404);
}

// POST {title, detail?, kind?, ref?, pieceId?, source?: "manual" | "pin" | "verify"}
export async function POST(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  if (!getFeature(fid)) return err("not found", 404);
  const body = (await req.json().catch(() => ({}))) as { source?: string };
  const issue = cleanIssue(body);
  if (!issue) return err("title required");
  const source: IssueSource = body.source === "pin" || body.source === "verify" ? body.source : "manual";
  try {
    const { feature } = await logIssues(fid, [issue], source);
    return NextResponse.json(pieceView(feature, pieceIdFrom(req.url)));
  } catch (e) {
    return fail(e);
  }
}

// PATCH {issueId, title?, detail?, kind?, status?: "open" | "dropped"}
export async function PATCH(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof b.issueId !== "string") return err("issueId required");
  const p: IssuePatch = {
    ...(typeof b.title === "string" && { title: b.title }),
    ...(typeof b.detail === "string" && { detail: b.detail }),
    ...(typeof b.kind === "string" && { kind: b.kind as IssueKind }),
    ...((b.status === "open" || b.status === "dropped") && { status: b.status }),
  };
  try {
    return NextResponse.json(pieceView(await patchIssue(fid, b.issueId, p), pieceIdFrom(req.url)));
  } catch (e) {
    return fail(e);
  }
}

// DELETE ?issueId=
export async function DELETE(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const iid = new URL(req.url).searchParams.get("issueId");
  if (!iid) return err("issueId required");
  try {
    return NextResponse.json(pieceView(await deleteIssue(fid, iid), pieceIdFrom(req.url)));
  } catch (e) {
    return fail(e);
  }
}
