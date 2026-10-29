import "server-only";
import { z } from "zod";
import { wrongApp } from "./appowner";
import { loginHref } from "./auth";
import { captureUrl, removeShot } from "./capture";
import { featurePrompt, generate } from "./llm";
import { pieceView } from "./pieces";
import { planSketch } from "./sketch";
import { getSettings, id, now } from "./store";
import type { Feature, FeatureView, Mockup, Piece } from "./types";

// The background "sketch" job: pick 1..3 real screens this piece touches, screenshot them in the running
// app, and mark them up. Runs after the piece's stories (their acceptance startPaths are the routes we know exist).

export interface Target {
  path: string; // route the change is about (for a new screen: the route it will live at)
  intent: string; // <= 15 words, what changes there
  newScreen?: boolean; // the feature creates this screen: we sketch on parentPath instead
  parentPath?: string; // existing route to sketch a new screen onto
}

export const MAX_TARGETS = 3;
export const BUDGET_MS = 180_000;
const REACH_TIMEOUT_MS = 3000;

const words = (s: string, n: number) => s.trim().split(/\s+/).filter(Boolean).slice(0, n).join(" ");

// "/a/b/?x#y", "a/b", "http://host/a/b" → "/a/b?x" (query kept: it can pick a tab); "" when unusable
export function normPath(raw: string | undefined | null): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  try {
    const u = new URL(s, "http://x");
    if (!/^https?:$/.test(u.protocol)) return "";
    const p = u.pathname.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
    return `${p}${u.search}`;
  } catch {
    return "";
  }
}

// The capture target: a new screen is sketched on its parent.
export const shotPath = (t: Target) => (t.newScreen && t.parentPath ? t.parentPath : t.path);

// Routes we have seen exist: every story's acceptance startPath (all pieces), routes captured by hand,
// and brief surfaces that are routes. The piece's own startPaths come first.
export function observedRoutes(f: Feature | FeatureView, piece: Pick<Piece, "stories">): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    const n = normPath(p);
    if (n && !out.includes(n)) out.push(n);
  };
  for (const s of piece.stories) for (const a of s.acceptance) add(a.startPath);
  for (const p of f.pieces ?? []) for (const s of p.stories) for (const a of s.acceptance) add(a.startPath);
  for (const p of f.pieces ?? [])
    for (const m of p.mockups.filter((x) => !x.auto)) // a page a person captured; the job's own sketches prove nothing
      try {
        add(new URL(m.url).pathname);
      } catch {
        /* skip */
      }
  for (const s of f.briefDoc?.surfaces ?? []) if (/^\/[\w\-/:[\].]*$/.test(s.trim())) add(s);
  return out;
}

// Closest observed route above `path` ("/settings/members/new" → "/settings/members"), else the observed route
// sharing the longest leading segments with it.
export function nearestParent(path: string, allowed: string[]): string | undefined {
  const segs = normPath(path).split("?")[0].split("/").filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const cand = `/${segs.slice(0, i).join("/")}`;
    if (allowed.includes(cand)) return cand;
  }
  let best: { p: string; n: number } | undefined;
  for (const a of allowed) {
    const as = a.split("?")[0].split("/").filter(Boolean);
    let n = 0;
    while (n < as.length && n < segs.length && as[n] === segs[n]) n++;
    if (n > 0 && (!best || n > best.n)) best = { p: a, n };
  }
  return best?.p;
}

export type RawTarget = { path: string; intent: string; newScreen: boolean; parentPath: string };

// Model output → 1..3 targets on routes that exist. Unknown routes are dropped unless flagged new (then they
// move onto the nearest existing parent with an "insert new screen" intent). Deduped by the page we'd capture.
export function shapeTargets(raw: RawTarget[], allowed: string[], fallback?: Target): Target[] {
  const out: Target[] = [];
  for (const r of raw) {
    const path = normPath(r.path);
    if (!path) continue;
    let t: Target | undefined;
    if (allowed.includes(path)) t = { path, intent: words(r.intent, 15) };
    else if (r.newScreen) {
      const given = normPath(r.parentPath);
      const parent = allowed.includes(given) ? given : nearestParent(path, allowed);
      if (!parent) continue;
      const base = words(r.intent.replace(/^\s*new( screen)?\s*[:—-]\s*/i, ""), 15);
      const intent = /new screen/i.test(base) ? base : words(`insert new screen ${path}: ${base}`, 15);
      t = { path, intent, newScreen: true, parentPath: parent };
    }
    if (!t || !t.intent) continue;
    if (out.some((o) => shotPath(o) === shotPath(t))) continue;
    out.push(t);
    if (out.length >= MAX_TARGETS) break;
  }
  return out.length || !fallback ? out : [fallback];
}

const Out = z.object({
  targets: z
    .array(
      z.object({
        path: z.string().describe("route, e.g. /settings/members. for a new screen: the route it will live at"),
        intent: z.string().describe("<= 15 words: what changes on this screen, for the marker"),
        newScreen: z.boolean().describe("true only if this piece creates this screen (it does not exist yet)"),
        parentPath: z.string().describe("newScreen: an EXISTING route to sketch it onto (where it's reached from). else empty"),
      }),
    )
    .describe("1-3 screens, most important first"),
});

// routes: what the live app answered for (existing) vs 404'd (missing: stories name screens that don't exist
// yet). Without it, every observed route counts as existing.
export async function pickTargets(
  f: Feature | FeatureView,
  piece: Piece,
  opts: { signal?: AbortSignal; routes?: { existing: string[]; missing: string[] } } = {},
): Promise<Target[]> {
  const view = pieceView(f as Feature, piece.id);
  const allowed = opts.routes?.existing ?? observedRoutes(f, piece);
  const missing = opts.routes?.missing ?? [];
  // fallback: only one of this piece's own routes that exists (never the app root just because it answers)
  const first = observedRoutes({ ...f, pieces: [] } as Feature, piece).find((r) => allowed.includes(r));
  const fallback = first ? { path: first, intent: words(`${piece.title}: where it lands`, 15) } : undefined;
  if (!allowed.length) return [];
  const stories = piece.stories
    .map((s) => `- as ${s.role}, ${s.want}${s.acceptance.length ? ` (starts at ${[...new Set(s.acceptance.map((a) => a.startPath))].join(", ")})` : ""}`)
    .join("\n");
  const prompt = `${featurePrompt(view)}

piece: ${piece.title}${piece.why ? ` — ${piece.why}` : ""}${piece.scope?.length ? `\nscope:\n${piece.scope.map((s) => `- ${s}`).join("\n")}` : ""}${
    f.briefDoc?.surfaces.length ? `\nsurfaces: ${f.briefDoc.surfaces.join(", ")}` : ""
  }
stories:
${stories || "(none yet)"}

routes that exist in the running app (only these can be screenshotted):
${allowed.map((r) => `- ${r}`).join("\n")}${
    missing.length ? `\nroutes the stories mention that do NOT exist yet (new screens):\n${missing.map((r) => `- ${r}`).join("\n")}` : ""
  }

pick 1-3 screens of the real app to mark up for THIS piece. use only the routes listed. a screen this piece creates →
newScreen true + parentPath = the listed route it's reached from (we sketch "insert new screen" there).`;
  const out = await generate({ schema: Out, prompt, effort: "low", maxTokens: 1200, signal: opts.signal });
  return shapeTargets(out.targets, allowed, fallback);
}

// Anything answering (even 404 / 500) counts as running; a refused / timed-out connection doesn't.
export async function reachable(url: string, timeoutMs = REACH_TIMEOUT_MS): Promise<boolean> {
  try {
    await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

// A finished run replaces the piece's earlier auto sketches (stale pages included). Auto sketches a person
// edited (marks or re-sketch → `edited`) and manual captures always stay. Auto first.
export function mergeAutoMockups(existing: Mockup[], fresh: Mockup[]): { mockups: Mockup[]; removed: Mockup[] } {
  const removed = existing.filter((m) => m.auto && !m.edited);
  const kept = existing.filter((m) => !removed.includes(m));
  return { mockups: [...fresh, ...kept.filter((m) => m.auto), ...kept.filter((m) => !m.auto)], removed };
}

// Which observed routes the live app knows: anything but a 404 exists (a redirect to login does too).
// The root is NOT added for free: an unrelated landing page is no place to sketch a feature.
export async function probeRoutes(base: string, routes: string[], timeoutMs = REACH_TIMEOUT_MS) {
  const res = await Promise.all(
    routes.slice(0, 20).map(async (r) => {
      try {
        const x = await fetch(new URL(r, base), { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
        return x.status !== 404;
      } catch {
        return false;
      }
    }),
  );
  return { existing: routes.filter((_, i) => res[i]), missing: routes.filter((_, i) => !res[i]) };
}

async function status(url: string, timeoutMs = REACH_TIMEOUT_MS): Promise<number | undefined> {
  try {
    return (await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) })).status;
  } catch {
    return undefined;
  }
}

export class AppDown extends Error {}

const errLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 80);

// Settles on abort even if `p` ignores it (p itself is given the same signal and stops / cleans up).
function untilAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((res, rej) => {
    if (signal.aborted) return rej(new Error("out of time"));
    const onAbort = () => rej(new Error("out of time"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(res, rej).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// new screens: one placeholder insert at the entry point, at most one open question
const NEW_SCREEN_RULES =
  "this screen does not exist yet: return at least one insert mark (a placeholder panel for the new screen, anchored where it is reached from) and at most one note.";

export function trimNewScreenMarks(anns: Mockup["annotations"]): Mockup["annotations"] {
  let notes = 0;
  return anns.filter((a) => a.kind !== "note" || notes++ < 1);
}

// The whole job, outside the store lock: targets → reachability → capture one page at a time → marker.
// Throws AppDown when the app isn't answering, and when nothing could be captured. When none of the piece's
// screens exist yet it captures nothing and says so (no unrelated page gets marked up). `skipped` explains gaps.
export async function autoSketch(
  f: Feature | FeatureView,
  piece: Piece,
  opts: { signal?: AbortSignal; budgetMs?: number } = {},
): Promise<{ mockups: Mockup[]; skipped: string[] }> {
  const t0 = Date.now();
  const budget = opts.budgetMs ?? BUDGET_MS;
  const left = () => budget - (Date.now() - t0);
  // one signal for everything: the caller's, or the budget running out. Captures close their browser on it.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), budget);
  const onOuter = () => ac.abort();
  opts.signal?.addEventListener("abort", onOuter, { once: true });
  if (opts.signal?.aborted) ac.abort();
  const signal = ac.signal;
  try {
    const settings = getSettings();
    const base = settings.frontendUrl;
    if (!(await reachable(base))) throw new AppDown(`app not running at ${base}`);
    const other = await wrongApp(base, settings.repoPath);
    if (other) throw new AppDown(other); // another repo's dev server owns the port

    const observed = observedRoutes(f, piece);
    if (!observed.length) throw new Error("no known routes yet — add stories with start paths");
    const routes = await probeRoutes(base, observed);
    const targets = await untilAbort(pickTargets(f, piece, { signal, routes }), signal);
    if (!targets.length) {
      const own = observedRoutes({ ...f, pieces: [] } as Feature, piece).filter((r) => routes.missing.includes(r));
      const gone = own[0] ?? routes.missing[0];
      return { mockups: [], skipped: [gone ? `no existing screen for ${gone} yet (404) — sketch after the route exists` : "no screen to sketch yet"] };
    }

    const acc = settings.accounts[0];
    let accountId: string | undefined = acc?.id; // dropped after one failed login: the rest go in signed out
    const loginUrl = acc ? loginHref(acc, base) : new URL("/login", base).href;
    const loginPath = new URL(loginUrl).pathname;
    const view = pieceView(f as Feature, piece.id);
    const mockups: Mockup[] = [];
    const skipped: string[] = [];

    for (const t of targets) {
      const at = shotPath(t);
      if (signal.aborted || left() < 15_000) {
        skipped.push(`skipped ${at} — out of time`);
        continue;
      }
      const shoot = (aid?: string) => untilAbort(captureUrl({ url: new URL(at, base).href, accountId: aid, signal }), signal);
      let cap: Awaited<ReturnType<typeof captureUrl>>;
      try {
        cap = await shoot(accountId).catch(async (e) => {
          if (!accountId || !errLine(e).startsWith("login:") || signal.aborted) throw e;
          const code = await status(loginUrl);
          skipped.push(
            code === 404
              ? `login page ${loginPath} not found (404) — fix the test account in settings · captured signed out`
              : `${acc?.label ?? "test account"} ${errLine(e).replace(/^login:\s*/, "login failed: ")} — check the test account in settings · captured signed out`,
          );
          accountId = undefined;
          return shoot(undefined);
        });
      } catch (e) {
        skipped.push(`skipped ${at} — ${errLine(e)}`);
        continue;
      }
      const landed = new URL(cap.url).pathname;
      const gone = /^404\b|not found/i.test(cap.title);
      if ((loginPath !== "/" && landed.startsWith(loginPath) && !at.startsWith(loginPath)) || gone) {
        removeShot(cap.shot);
        skipped.push(`skipped ${at} — ${gone ? "page not found" : "landed on login"}`);
        continue;
      }
      const m: Mockup = {
        id: id("mk"),
        url: cap.url,
        title: cap.title,
        shot: cap.shot,
        thumb: cap.thumb,
        width: cap.width,
        height: cap.height,
        elements: cap.elements,
        annotations: [],
        intent: t.intent,
        auto: true,
        createdAt: now(),
      };
      // facts the marker must not invent (e.g. "behind sign-in" for a route that simply doesn't exist)
      const context = [
        t.newScreen ? `${t.path} does not exist in the app yet (404). you are looking at ${at}, where it will be reached from. ${NEW_SCREEN_RULES}` : "",
        accountId ? "" : "captured signed out (the test account could not sign in) — do not explain gaps as sign-in walls.",
      ]
        .filter(Boolean)
        .join("\n");
      if (left() > 10_000 && !signal.aborted) {
        const anns = await untilAbort(planSketch(view, m, t.intent, { signal, context }), signal).catch((e) => {
          skipped.push(`${at} — marker failed: ${errLine(e)}`);
          return [];
        });
        m.annotations = t.newScreen ? trimNewScreenMarks(anns) : anns;
      }
      mockups.push(m);
    }
    if (!mockups.length) throw new Error(`couldn't capture: ${skipped.join("; ")}`.slice(0, 140));
    return { mockups, skipped };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuter);
  }
}
