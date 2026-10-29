"use client";

import type { FeatureView, IssueKind, IssueRef } from "@/lib/types";

// Issue writes return the feature view; FEATURE_EVENT hands it to the workspace (flags live deep inside
// tabs that don't hold onChange for the whole feature).
export const FEATURE_EVENT = "lambda:feature";

export type IssueBody = { title: string; detail?: string; kind?: IssueKind; ref?: IssueRef; pieceId?: string; source?: "manual" | "pin" | "verify" };

async function call(url: string, init: RequestInit): Promise<FeatureView> {
  const res = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body as FeatureView;
}

const base = (fid: string, pieceId?: string) => `/api/features/${fid}/issues${pieceId ? `?piece=${encodeURIComponent(pieceId)}` : ""}`;

export const addIssue = (fid: string, b: IssueBody) => call(base(fid, b.pieceId), { method: "POST", body: JSON.stringify(b) });
export const patchIssue = (fid: string, pieceId: string, issueId: string, p: { title?: string; detail?: string; kind?: IssueKind; status?: "open" | "dropped" }) =>
  call(base(fid, pieceId), { method: "PATCH", body: JSON.stringify({ issueId, ...p }) });
export const removeIssue = (fid: string, pieceId: string, issueId: string) =>
  call(`${base(fid, pieceId)}${pieceId ? "&" : "?"}issueId=${encodeURIComponent(issueId)}`, { method: "DELETE" });

export async function buildIssues(fid: string, issueIds: string[]): Promise<string> {
  const res = await fetch(`/api/features/${fid}/issues/build`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ issueIds }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return (body as { id: string }).id;
}

// pin an issue from anywhere; the workspace absorbs the returned view
export async function flagIssue(fid: string, b: IssueBody): Promise<void> {
  const view = await addIssue(fid, b);
  window.dispatchEvent(new CustomEvent(FEATURE_EVENT, { detail: view }));
}
