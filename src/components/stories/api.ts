import type { ChangeNote, FeatureOp } from "@/lib/ops";
import type { FeatureView } from "@/lib/types";

// Thin client for the stories board. Edits go through the shared ops route; generation stays on /stories.
// Every call is scoped to one piece (pieceId; "" = first piece) and returns that piece's view.

async function call<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body as T;
}

const base = (fid: string) => `/api/features/${fid}`;

export const storiesApi = {
  generate: (fid: string, pieceId?: string) =>
    call<FeatureView>(`${base(fid)}/stories`, { method: "POST", body: JSON.stringify({ pieceId: pieceId || undefined }) }),
  get: (fid: string, pieceId?: string) => call<FeatureView>(`${base(fid)}${pieceId ? `?piece=${encodeURIComponent(pieceId)}` : ""}`, { method: "GET" }),
  ops: (fid: string, ops: FeatureOp[], keepalive = false, pieceId?: string) =>
    call<{ feature: FeatureView; notes: ChangeNote[] }>(`${base(fid)}/ops`, {
      method: "POST",
      body: JSON.stringify({ ops, pieceId: pieceId || undefined }),
      keepalive,
    }),
  // name the piece's journey steps and place every story in one (src/lib/journey.ts)
  journey: (fid: string, pieceId?: string) =>
    call<FeatureView>(`${base(fid)}/journey`, { method: "POST", body: JSON.stringify({ pieceId: pieceId || undefined }) }),
  verify: (fid: string, storyId: string) =>
    call<{ feature: FeatureView; runId: string }>(`${base(fid)}/verify`, { method: "POST", body: JSON.stringify({ storyId }) }),
};

// Cross-tab focus bus: chat change cards + "run in browser" use it.
export type FocusDetail = { tab: string; ref?: string; scope?: string };
export const focusTab = (detail: FocusDetail) => window.dispatchEvent(new CustomEvent<FocusDetail>("lambda:focus", { detail }));
