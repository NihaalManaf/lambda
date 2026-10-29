import { NextResponse } from "next/server";
import { getSettings, id, saveSettings } from "@/lib/store";
import type { Settings, TestAccount } from "@/lib/types";
import { clearAuth, loginOriginChanged } from "@/lib/auth";
import { MODELS } from "@/components/settings/types";
import { settingsView as view } from "@/components/settings/view";
import { validBaseBranch } from "@/lib/baseref";

export async function GET() {
  return NextResponse.json(view(getSettings()));
}

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);

// Partial patch. `accounts`, when present, is the full list: upsert by id, missing = removed,
// empty password = keep the stored one — unless the login origin moved (then it's dropped, so a
// changed url can never receive the old password). Cached logins are cleared on any credential change.
export async function PUT(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const cur = getSettings();
  const patch: Partial<Settings> = {};
  for (const k of ["envPath", "frontendUrl", "repoPath"] as const) {
    const v = str(body[k], 1000);
    if (v !== undefined) patch[k] = v;
  }
  // ends up in git argv: a bad ref is never saved (the rest of the patch is); the form sees the returned
  // baseBranch differ from what it sent and marks the field
  const base = str(body.baseBranch, 200);
  if (base !== undefined && (base === "" || validBaseBranch(base))) patch.baseBranch = base;
  for (const k of ["migrationsDir", "baselineSchemaPath"] as const) {
    const v = str(body[k], 1000);
    if (v !== undefined) patch[k] = v;
  }
  for (const k of ["extraMigrationDirs", "queueIgnore", "appHosts"] as const)
    if (Array.isArray(body[k]))
      patch[k] = (body[k] as unknown[]).map((x) => str(x, 300)).filter((x): x is string => !!x).slice(0, 50);
  if (typeof body.model === "string" && MODELS.includes(body.model)) patch.model = body.model;
  if (typeof body.edgeCases === "boolean") patch.edgeCases = body.edgeCases;
  if (Array.isArray(body.accounts)) {
    patch.accounts = (body.accounts as Record<string, unknown>[]).slice(0, 50).map((a) => {
      const aid = typeof a.id === "string" && /^acct_[\w-]{1,40}$/.test(a.id) ? a.id : id("acct");
      const prev = cur.accounts.find((x) => x.id === aid);
      const pw = typeof a.password === "string" && a.password !== "" ? a.password.slice(0, 500) : prev?.password ?? "";
      return {
        id: aid,
        label: str(a.label, 80) ?? "",
        loginUrl: str(a.loginUrl, 1000) ?? "",
        email: str(a.email, 200) ?? "",
        password: pw,
        notes: str(a.notes, 500) || undefined,
      };
    });
  }
  const nextFront = patch.frontendUrl ?? cur.frontendUrl;
  const next: TestAccount[] = (patch.accounts ?? cur.accounts).map((a) => {
    const prev = cur.accounts.find((x) => x.id === a.id);
    if (!prev) return a;
    const sent = (body.accounts as Record<string, unknown>[] | undefined)?.find((x) => x.id === a.id);
    const freshPw = typeof sent?.password === "string" && sent.password !== "";
    const moved = loginOriginChanged(prev, a, cur.frontendUrl, nextFront);
    const out = moved && !freshPw ? { ...a, password: "" } : a;
    if (moved || out.email !== prev.email || out.password !== prev.password || out.loginUrl !== prev.loginUrl)
      clearAuth(a.id);
    return out;
  });
  for (const a of cur.accounts) if (!next.some((x) => x.id === a.id)) clearAuth(a.id);
  if (patch.accounts || nextFront !== cur.frontendUrl) patch.accounts = next;
  return NextResponse.json(view(saveSettings(patch)));
}
