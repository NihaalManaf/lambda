import type { Annotation, Feature, Mockup } from "@/lib/types";

// Client calls for the sketch tool. Every mutation returns the whole Feature.

export type SketchMockup = Mockup & { intent?: string; thumb?: string };

async function call<T>(url: string, init?: RequestInit): Promise<{ data: T; res: Response }> {
  const res = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `${res.status}`);
  return { data: data as T, res };
}

const base = (fid: string) => `/api/features/${fid}/mockups`;

export async function captureMockup(fid: string, body: { url?: string; path?: string; accountId?: string; intent?: string }) {
  const { data, res } = await call<Feature>(base(fid), { method: "POST", body: JSON.stringify(body) });
  const warn = res.headers.get("x-sketch-error");
  return { feature: data, sketchError: warn ? decodeURIComponent(warn) : undefined };
}

export const resketch = (fid: string, mid: string, intent: string) =>
  call<Feature>(`${base(fid)}/${mid}/sketch`, { method: "POST", body: JSON.stringify({ intent }) }).then((r) => r.data);

export const saveAnnotations = (fid: string, mid: string, annotations: Annotation[]) =>
  call<Feature>(`${base(fid)}/${mid}`, { method: "PATCH", body: JSON.stringify({ annotations }) }).then((r) => r.data);

export const deleteMockup = (fid: string, mid: string) =>
  call<Feature>(`${base(fid)}/${mid}`, { method: "DELETE" }).then((r) => r.data);

export const shotUrl = (name: string) => `/api/shots/${encodeURIComponent(name)}`;

export interface SettingsLite {
  frontendUrl: string;
  accounts: { id: string; label: string; email?: string }[];
}

export async function loadSettings(): Promise<SettingsLite> {
  try {
    const r = await fetch("/api/settings");
    if (!r.ok) throw new Error();
    const s = (await r.json()) as Partial<SettingsLite>;
    return { frontendUrl: s.frontendUrl || "http://localhost:3000", accounts: Array.isArray(s.accounts) ? s.accounts : [] };
  } catch {
    return { frontendUrl: "http://localhost:3000", accounts: [] };
  }
}
