// Route index: full path -> handler. Python routes come pre-mounted (router prefixes from app.py);
// cron routes are /v1/internal/crons/{schedule_id}; Next.js routes are src/app/api/**/route.ts with Receiver.
import type { RawRoute } from "./types";

export interface RouteHit { file: string; line: number; fn: string; auth: RawRoute["auth"]; route: RawRoute }

const toRx = (p: string) =>
  new RegExp(`^${p.replace(/\/+$/, "").split(/(\{[^}]*\})/).map((s) => (s.startsWith("{") ? "[^/]+" : s.replace(/[.*+?^$()|[\]\\]/g, "\\$&"))).join("")}/?$`);

export class RouteIndex {
  private exact = new Map<string, RawRoute[]>();
  private params: { rx: RegExp; r: RawRoute }[] = [];
  constructor(readonly routes: RawRoute[]) {
    for (const r of routes) {
      const p = r.path.replace(/\/+$/, "") || "/";
      if (p.includes("{")) this.params.push({ rx: toRx(p), r });
      else this.exact.set(p, [...(this.exact.get(p) ?? []), r]);
    }
  }
  // POST wins (queues deliver POST); {} segments in the key match any param.
  find(key: string): RouteHit | null {
    const k = key.replace(/\/+$/, "") || "/";
    let cands = this.exact.get(k) ?? [];
    if (!cands.length) cands = this.params.filter((p) => p.rx.test(k.replace(/\{\}/g, "x"))).map((p) => p.r);
    if (!cands.length && k.includes("{}")) {
      const rx = toRx(k);
      cands = this.routes.filter((r) => rx.test(r.path.replace(/\{[^}]*\}/g, "x")));
    }
    const r = cands.find((c) => c.method === "post") ?? cands.find((c) => c.method === "api_route") ?? cands[0];
    return r ? { file: r.file, line: r.line, fn: r.fn, auth: r.auth, route: r } : null;
  }
  paths(): string[] {
    return [...new Set(this.routes.map((r) => r.path))];
  }
}
