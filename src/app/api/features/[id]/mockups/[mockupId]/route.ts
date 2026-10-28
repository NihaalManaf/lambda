import { NextResponse } from "next/server";
import { z } from "zod";
import { removeShot } from "@/lib/capture";
import { getFeature, id as newId, updateFeature } from "@/lib/store";
import type { Annotation } from "@/lib/types";

type Ctx = { params: Promise<{ id: string; mockupId: string }> };

const BoxZ = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
const AnnZ = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/).optional(),
  kind: z.enum(["insert", "remove", "move", "change-text", "restyle", "note"]),
  box: BoxZ,
  label: z.string().max(80),
  detail: z.string().max(240).optional(),
  to: BoxZ.optional(),
  newText: z.string().max(120).optional(),
});
const Body = z.object({ annotations: z.array(AnnZ).max(60) });

// PATCH {annotations} -> Feature (manual edits from the sketch canvas)
export async function PATCH(req: Request, { params }: Ctx) {
  const { id, mockupId } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad annotations" }, { status: 400 });
  if (!getFeature(id)?.mockups.some((m) => m.id === mockupId))
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const f = await updateFeature(id, (f) => {
    const m = f.mockups.find((m) => m.id === mockupId);
    if (!m) return;
    const fit = (b: z.infer<typeof BoxZ>) => {
      const x = Math.max(0, Math.min(Math.round(b.x), m.width - 10));
      const y = Math.max(0, Math.min(Math.round(b.y), m.height - 10));
      return { x, y, w: Math.max(10, Math.min(Math.round(b.w), m.width - x)), h: Math.max(10, Math.min(Math.round(b.h), m.height - y)) };
    };
    m.annotations = parsed.data.annotations.map(
      (a): Annotation => ({
        id: a.id ?? newId("an"),
        kind: a.kind,
        box: fit(a.box),
        label: a.label.trim(),
        ...(a.detail?.trim() ? { detail: a.detail.trim() } : {}),
        ...(a.kind === "move" && a.to ? { to: fit(a.to) } : {}),
        ...(a.kind === "change-text" && a.newText?.trim() ? { newText: a.newText.trim() } : {}),
      }),
    );
  });
  return NextResponse.json(f);
}

export async function DELETE(_: Request, { params }: Ctx) {
  const { id, mockupId } = await params;
  if (!getFeature(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  let shot: string | undefined;
  const f = await updateFeature(id, (f) => {
    shot = f.mockups.find((m) => m.id === mockupId)?.shot;
    f.mockups = f.mockups.filter((m) => m.id !== mockupId);
  });
  if (shot) removeShot(shot);
  return NextResponse.json(f);
}
