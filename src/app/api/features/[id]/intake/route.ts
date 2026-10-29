import { NextResponse } from "next/server";
import { intakeLive, IntakeBusyError, isIntakeLive, runIntakeTurn, type IntakeEvent } from "@/lib/intake";
import path from "node:path";
import { getFeature, getSettings } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

type Ctx = { params: Promise<{ id: string }> };

// GET -> { live, trace?, text?, phase, status, repo } (repo = configured repo's folder name, or null) — lets a reloaded page pick up a turn still running
export async function GET(_: Request, { params }: Ctx) {
  const f = getFeature((await params).id);
  if (!f) return NextResponse.json({ error: "not found" }, { status: 404 });
  const repoPath = getSettings().repoPath;
  return NextResponse.json({ ...intakeLive(f.id), phase: f.phase, status: f.intake?.status ?? "idle", repo: repoPath ? path.basename(repoPath) : null });
}

// POST {text} -> text/event-stream of IntakeEvent ("data: {json}\n\n"). The turn keeps running (and
// persists) if the client goes away; POST ./stop ends it.
export async function POST(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  const f = getFeature(fid);
  if (!f) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (f.phase !== "intake") return NextResponse.json({ error: "intake is done — use ask lambda" }, { status: 409 });
  const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim().slice(0, 4000) : "";
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
  if (isIntakeLive(fid)) return NextResponse.json({ error: "lambda is still thinking" }, { status: 409 });

  const enc = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (e: IntakeEvent) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          open = false;
        }
      };
      const close = () => {
        if (!open) return;
        open = false;
        try {
          controller.close();
        } catch {}
      };
      runIntakeTurn(fid, text, emit)
        .catch((e) => emit({ type: "error", message: e instanceof IntakeBusyError ? e.message : e instanceof Error ? e.message : String(e) }))
        .finally(close);
    },
    cancel() {
      open = false; // the turn runs on and persists
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
