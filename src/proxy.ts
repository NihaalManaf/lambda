import { NextResponse, type NextRequest } from "next/server";

// Local-only guard. lambda holds test passwords + slack/linear/session data and can start paid runs:
//  - Host must be loopback (blocks DNS rebinding)
//  - mutating /api calls must be same-origin (blocks CSRF) and send json bodies (no text/plain simple posts)
//  - nothing relayed by a QStash server (lambda's local stack runs one; qstash-cli listens on every
//    interface and can forward arbitrary headers, Origin included) — lambda never takes queue deliveries

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

const deny = (why: string) => NextResponse.json({ error: why }, { status: 403 });

// QStash always stamps its deliveries (Upstash-Message-Id / -Signature / -Retried) and its user agent
function relayed(req: NextRequest): boolean {
  if (/qstash|upstash/i.test(req.headers.get("user-agent") ?? "")) return true;
  for (const k of req.headers.keys()) if (k.toLowerCase().startsWith("upstash-")) return true;
  return false;
}

export function proxy(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  if (!LOOPBACK.test(host)) return deny("lambda only answers on localhost");
  if (relayed(req)) return deny("lambda doesn't take relayed requests");
  if (SAFE.has(req.method) || !req.nextUrl.pathname.startsWith("/api/")) return NextResponse.next();

  const origin = req.headers.get("origin");
  if (origin) {
    let oh = "";
    try {
      oh = new URL(origin).host;
    } catch {}
    if (oh !== host) return deny("cross-origin request");
  }
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return deny("cross-site request");

  const hasBody = Number(req.headers.get("content-length") ?? 0) > 0 || req.headers.has("transfer-encoding");
  if (hasBody && !(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
    return deny("json only");
  return NextResponse.next();
}

// public art assets are excluded: next/image fetches them internally with a non-loopback host
export const config = { matcher: "/((?!_next/static|_next/image|art/|favicon.ico).*)" };
