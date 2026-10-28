import fs from "node:fs/promises";
import path from "node:path";
import { SHOTS_DIR } from "@/lib/store";

type Ctx = { params: Promise<{ name: string }> };

// GET a screenshot. Names are generated ids: strict allowlist, no traversal.
export async function GET(_: Request, { params }: Ctx) {
  const { name } = await params;
  if (!/^[\w-]+\.png$/.test(name)) return new Response("bad name", { status: 400 });
  try {
    const buf = await fs.readFile(path.join(SHOTS_DIR, name));
    return new Response(new Uint8Array(buf), {
      headers: { "content-type": "image/png", "cache-control": "private, max-age=31536000, immutable" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
