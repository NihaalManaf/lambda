import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { deleteFeature, getFeature, SHOTS_DIR, updateFeature } from "@/lib/store";
import { cancelFeatureRuns } from "@/lib/verify";
import type { Feature } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: Ctx) {
  const f = getFeature((await params).id);
  return f ? NextResponse.json(f) : NextResponse.json({ error: "not found" }, { status: 404 });
}

// Shallow patch of editable top-level fields.
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!getFeature(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const patch = (await req.json()) as Partial<Pick<Feature, "title" | "brief" | "status">>;
  const f = await updateFeature(id, (f) => {
    if (patch.title !== undefined) f.title = patch.title;
    if (patch.brief !== undefined) f.brief = patch.brief;
    if (patch.status !== undefined) f.status = patch.status;
  });
  return NextResponse.json(f);
}

// Also drops the feature's screenshots + run dirs (all ids are store-generated, no user paths).
export async function DELETE(_: Request, { params }: Ctx) {
  const { id } = await params;
  const f = getFeature(id);
  cancelFeatureRuns(id); // stop agents before their dirs go
  await deleteFeature(id);
  const files = [
    ...(f?.mockups ?? []).flatMap((m) => [m.shot, m.thumb]),
    ...(f?.runs ?? []).map((r) => r.id),
  ].filter((n): n is string => !!n && /^[\w-]+(\.png)?$/.test(n));
  for (const n of files) fs.rmSync(path.join(SHOTS_DIR, n), { recursive: true, force: true });
  return NextResponse.json({ ok: true });
}
