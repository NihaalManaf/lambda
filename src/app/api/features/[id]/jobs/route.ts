import { NextResponse } from "next/server";
import { JOB_KINDS, startJobs, sweepStale } from "@/lib/jobs";
import { pieceIdFrom, pieceView } from "@/lib/pieces";
import { getFeature } from "@/lib/store";
import type { JobKind } from "@/lib/types";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };
const err = (error: string, status = 400) => NextResponse.json({ error }, { status });

// GET ?piece= -> pieceView (after marking jobs orphaned by a restart as errored). The workspace polls this.
export async function GET(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  await sweepStale(fid);
  const f = getFeature(fid);
  return f ? NextResponse.json(pieceView(f, pieceIdFrom(req.url))) : err("not found", 404);
}

// POST {kinds?, pieceId?} -> pieceView with the jobs queued. No kinds = everything (context → every piece:
// facts → stories ∥ flows ∥ needs (→ schema/queues) → check, sketch after stories; with pieceId only that piece).
// Piece kinds go to pieceId or the first piece; stories / flows add facts (when missing) and check themselves.
export async function POST(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const b = (await req.json().catch(() => ({}))) as { kinds?: unknown; pieceId?: unknown };
  const pid = pieceIdFrom(req.url, b);
  let kinds: JobKind[] | undefined;
  if (b.kinds !== undefined) {
    if (!Array.isArray(b.kinds) || !b.kinds.length || !b.kinds.every((k) => JOB_KINDS.includes(k as JobKind)))
      return err(`kinds must be a non-empty subset of ${JOB_KINDS.join(", ")}`);
    kinds = b.kinds as JobKind[];
  }
  if (!getFeature(fid)) return err("not found", 404);
  await sweepStale(fid);
  try {
    return NextResponse.json(pieceView(await startJobs(fid, kinds, pid), pid));
  } catch (e) {
    return err(e instanceof Error ? e.message : "couldn't start", 500);
  }
}
