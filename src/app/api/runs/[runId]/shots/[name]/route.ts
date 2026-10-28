import fs from "node:fs";
import { shotPath } from "@/lib/verify";

type Ctx = { params: Promise<{ runId: string; name: string }> };

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

// Serve one run screenshot. runId + filename are regex-validated in shotPath.
export async function GET(_: Request, { params }: Ctx) {
  const { runId, name } = await params;
  const p = shotPath(runId, name);
  if (!p) return new Response("not found", { status: 404 });
  const ext = name.split(".").pop()!.toLowerCase();
  return new Response(new Uint8Array(fs.readFileSync(p)), {
    headers: { "content-type": TYPES[ext], "cache-control": "private, max-age=31536000, immutable" },
  });
}
