import { NextResponse } from "next/server";
import { clearThread, runChat, threadOf, type ChatEvent } from "@/lib/chat";
import { pieceIdFrom, pieceView } from "@/lib/pieces";
import { getFeature } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

const busy = new Set<string>(); // one conversation turn per feature at a time

export async function GET(_: Request, { params }: Ctx) {
  const f = getFeature((await params).id);
  return f ? NextResponse.json({ thread: threadOf(f) }) : NextResponse.json({ error: "not found" }, { status: 404 });
}

// POST {text, pieceId?} (pieceId = the selected piece; default first) -> text/event-stream of ChatEvent ("data: {json}\n\n").
export async function POST(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  if (!getFeature(fid)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { text?: unknown; pieceId?: unknown } | null;
  const pid = pieceIdFrom(req.url, body);
  const text = typeof body?.text === "string" ? body.text.trim().slice(0, 4000) : "";
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
  if (busy.has(fid)) return NextResponse.json({ error: "lambda is still answering" }, { status: 409 });
  busy.add(fid);

  const enc = new TextEncoder();
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (e: ChatEvent) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          open = false;
        }
      };
      try {
        await runChat(fid, text, emit, abort.signal, pid);
      } catch (e) {
        emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        busy.delete(fid);
        if (open) {
          open = false;
          try {
            controller.close();
          } catch {}
        }
      }
    },
    cancel() {
      abort.abort();
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

// DELETE -> fresh thread (pieceView)
export async function DELETE(req: Request, { params }: Ctx) {
  const fid = (await params).id;
  if (!getFeature(fid)) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (busy.has(fid)) return NextResponse.json({ error: "lambda is still answering" }, { status: 409 });
  return NextResponse.json(pieceView(await clearThread(fid), pieceIdFrom(req.url)));
}
