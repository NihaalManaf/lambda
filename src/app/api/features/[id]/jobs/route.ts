import { NextResponse } from "next/server";
import { JOB_KINDS, startJobs, sweepStale } from "@/lib/jobs";
import { getFeature } from "@/lib/store";
import type { JobKind } from "@/lib/types";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };
const err = (error: string, status = 400) => NextResponse.json({ error }, { status });

// GET -> Feature (after marking jobs orphaned by a restart as errored). The workspace polls this.
export async function GET(_: Request, { params }: Ctx) {
  const fid = (await params).id;
  await sweepStale(fid);
  const f = getFeature(fid);
  return f ? NextResponse.json(f) : err("not found", 404);
}

// POST {kinds?} -> Feature with the jobs queued. No kinds = everything (context → stories ∥ flows → schema/queues if needed).
export async function POST(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const b = (await req.json().catch(() => ({}))) as { kinds?: unknown };
  let kinds: JobKind[] | undefined;
  if (b.kinds !== undefined) {
    if (!Array.isArray(b.kinds) || !b.kinds.length || !b.kinds.every((k) => JOB_KINDS.includes(k as JobKind)))
      return err(`kinds must be a non-empty subset of ${JOB_KINDS.join(", ")}`);
    kinds = b.kinds as JobKind[];
  }
  if (!getFeature(fid)) return err("not found", 404);
  await sweepStale(fid);
  try {
    return NextResponse.json(await startJobs(fid, kinds));
  } catch (e) {
    return err(e instanceof Error ? e.message : "couldn't start", 500);
  }
}
