import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getTopology } from "@/lib/queues/cache";
import { nodeOf } from "@/lib/queues/graph";
import { langOf, snippet } from "@/lib/queues/scan";
import { getSettings } from "@/lib/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ nid: string }> };

// GET -> {node, risks, snippet}. The snippet is only shown behind the </> toggle.
export async function GET(_req: Request, { params }: Ctx) {
  const nid = decodeURIComponent((await params).nid);
  const t = getTopology();
  const node = t && nodeOf(t, nid);
  if (!t || !node) return NextResponse.json({ error: "not found" }, { status: 404 });
  const edgeIds = new Set(t.edges.filter((e) => e.from === nid || e.to === nid).map((e) => e.id));
  const risks = t.risks.filter((r) => r.target.id === nid || edgeIds.has(r.target.id));
  // channels have no file: show the first site that publishes into them
  const src = node.ref ?? t.edges.filter((e) => e.to === nid).map((e) => nodeOf(t, e.from)?.ref).find(Boolean);
  let code = "";
  if (src?.file) {
    const repo = getSettings().repoPath;
    const abs = path.resolve(repo, src.file);
    try {
      if (abs.startsWith(path.resolve(repo) + path.sep)) code = snippet(fs.readFileSync(abs, "utf8"), src.line, langOf(src.file));
    } catch {
      code = "";
    }
  }
  return NextResponse.json({ node, risks, snippet: code, ...(src && { ref: src }) });
}
