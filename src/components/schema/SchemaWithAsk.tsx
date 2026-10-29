"use client";

import { useState } from "react";
import Link from "next/link";
import AskBar from "@/components/askbar/AskBar";
import { mergePieceView, pieceView } from "@/lib/pieces";
import type { SchemaHead } from "@/lib/schema/types";
import type { Feature, FeatureView } from "@/lib/types";
import SchemaExplorer from "./SchemaExplorer";

// The schema page opened from a feature (?feature=&piece=): the explorer plus that feature's ask bar, which
// tells the chat which table is open. Edits land on the feature like they do in the workspace.
export default function SchemaWithAsk({
  head,
  initialTable,
  initialMigration,
  feature: initial,
  pieceId,
}: {
  head: SchemaHead;
  initialTable?: string;
  initialMigration?: string;
  feature: Feature;
  pieceId: string;
}) {
  const [stored, setStored] = useState(initial);
  const [table, setTable] = useState<string | null>(initialTable ?? null);
  const feature = pieceView(stored, pieceId);
  const onChange = (f: FeatureView) => setStored((cur) => mergePieceView(cur, f.pieceId || pieceId, f));

  return (
    <>
      <Link
        href={`/f/${stored.id}${pieceId ? `?piece=${encodeURIComponent(pieceId)}` : ""}`}
        className="mb-4 inline-block font-mono text-[12px] text-grey transition-colors hover:text-ink"
      >
        ← {stored.title}
      </Link>
      <SchemaExplorer head={head} initialTable={initialTable} initialMigration={initialMigration} onTable={setTable} />
      <AskBar feature={feature} pieceId={feature.pieceId} onChange={onChange} view={table ? { table } : undefined} />
    </>
  );
}
