import type { ChangeNote, FeatureOp } from "@/lib/ops";
import type { Feature } from "@/lib/types";

// Thin client for the stories board. Edits go through the shared ops route; generation stays on /stories + /size.

async function call<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body as T;
}

const base = (fid: string) => `/api/features/${fid}`;

export const storiesApi = {
  generate: (fid: string) => call<Feature>(`${base(fid)}/stories`, { method: "POST", body: "{}" }),
  resize: (fid: string) => call<Feature>(`${base(fid)}/size`, { method: "POST", body: "{}" }),
  get: (fid: string) => call<Feature>(base(fid), { method: "GET" }),
  ops: (fid: string, ops: FeatureOp[], keepalive = false) =>
    call<{ feature: Feature; notes: ChangeNote[] }>(`${base(fid)}/ops`, {
      method: "POST",
      body: JSON.stringify({ ops }),
      keepalive,
    }),
  verify: (fid: string, storyId: string) =>
    call<{ feature: Feature; runId: string }>(`${base(fid)}/verify`, { method: "POST", body: JSON.stringify({ storyId }) }),
};

// Cross-tab focus bus: chat change cards + "run in browser" use it.
export type FocusDetail = { tab: string; ref?: string; scope?: string };
export const focusTab = (detail: FocusDetail) => window.dispatchEvent(new CustomEvent<FocusDetail>("lambda:focus", { detail }));
