import { NextResponse } from "next/server";
import { changedSql } from "@/lib/schema/git";
import { getSettings } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET -> {files: {file, status}[]}: uncommitted .sql in the migration dirs
export async function GET() {
  const s = getSettings();
  try {
    return NextResponse.json({ files: await changedSql(s.repoPath, [s.migrationsDir, ...s.extraMigrationDirs].filter(Boolean)) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "git failed", files: [] }, { status: 502 });
  }
}
