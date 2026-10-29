import fs from "node:fs";
import path from "node:path";

// Frontend routes of a checkout, read from the file system (no model): Next app/ and pages/ dirs at any
// depth (e.g. frontend/src/app; never under components/). Route groups (x) are stripped, [param] segments
// kept; api/, private _dirs, parallel @slots, intercepting (.)routes and 404 / 500 pages are skipped.
// Grounds the facts session, the generators and the check stage's startPath check.

export type RouteEntry = { path: string; file: string }; // file relative to the root

const SKIP = new Set([
  "node_modules", ".git", ".next", ".turbo", ".vercel", ".cache", "dist", "build", "out", "coverage",
  "vendor", "venv", ".venv", "__pycache__", "target", "tmp",
]);
const PAGE_EXT = /\.(tsx|ts|jsx|js|mdx|md)$/;
const MAX_DEPTH = 7; // where an app/ or pages/ dir may sit
const MAX_ROUTES = 400;

const list = (dir: string) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

const isGroup = (seg: string) => /^\(.*\)$/.test(seg) && !seg.startsWith("(.");
const skipSeg = (seg: string) => seg.startsWith("_") || seg.startsWith("@") || seg.startsWith("(.") || seg.startsWith(".");
const join = (segs: string[]) => `/${segs.join("/")}`.replace(/\/+$/, "") || "/";

// app router: a dir holding page.* is a route
function appRoutes(root: string, dir: string, segs: string[], out: RouteEntry[]) {
  const entries = list(dir);
  const page = entries.find((e) => e.isFile() && /^page\.(tsx|ts|jsx|js|mdx|md)$/.test(e.name));
  if (page) out.push({ path: join(segs), file: path.relative(root, path.join(dir, page.name)) });
  for (const e of entries) {
    if (!e.isDirectory() || SKIP.has(e.name) || skipSeg(e.name)) continue;
    if (!segs.length && e.name === "api") continue;
    appRoutes(root, path.join(dir, e.name), isGroup(e.name) ? segs : [...segs, e.name], out);
  }
}

// pages router: every page file is a route (index → its dir)
function pagesRoutes(root: string, dir: string, segs: string[], out: RouteEntry[]) {
  for (const e of list(dir)) {
    if (e.isDirectory()) {
      if (SKIP.has(e.name) || e.name.startsWith("_") || e.name.startsWith(".") || (!segs.length && e.name === "api")) continue;
      pagesRoutes(root, path.join(dir, e.name), [...segs, e.name], out);
    } else if (e.isFile() && PAGE_EXT.test(e.name) && !/^_/.test(e.name) && !/\.(test|spec|d)\.[jt]sx?$/.test(e.name)) {
      const base = e.name.replace(PAGE_EXT, "");
      if (!segs.length && /^(404|500)$/.test(base)) continue; // error pages
      out.push({ path: join(base === "index" ? segs : [...segs, base]), file: path.relative(root, path.join(dir, e.name)) });
    }
  }
}

const hasPage = (dir: string, depth = 0): boolean =>
  depth < 8 &&
  list(dir).some(
    (e) =>
      (e.isFile() && /^page\.(tsx|ts|jsx|js|mdx|md)$/.test(e.name)) ||
      (e.isDirectory() && !SKIP.has(e.name) && hasPage(path.join(dir, e.name), depth + 1)),
  );
// a next project root: next.config.*, or a package.json that depends on next
const isNextRoot = (dir: string) => {
  if (list(dir).some((e) => e.isFile() && /^next\.config\.(js|mjs|cjs|ts|mts)$/.test(e.name))) return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    return !!(pkg.dependencies?.next ?? pkg.devDependencies?.next);
  } catch {
    return false;
  }
};
// a pages router: holds _app / _document, or sits at a next project root (or its src/). A components/pages
// barrel isn't one.
const isPagesDir = (dir: string) => {
  if (list(dir).some((e) => e.isFile() && /^(_app|_document)\.(tsx|ts|jsx|js)$/.test(e.name))) return true;
  const parent = path.dirname(dir);
  return isNextRoot(path.basename(parent) === "src" ? path.dirname(parent) : parent);
};

// Every frontend route under root, sorted, unique by path (first file wins).
export function scanRoutes(root: string): RouteEntry[] {
  const out: RouteEntry[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const e of list(dir)) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith(".") || e.name === "components") continue;
      const p = path.join(dir, e.name);
      if (e.name === "app" && hasPage(p)) appRoutes(root, p, [], out);
      else if (e.name === "pages" && isPagesDir(p)) pagesRoutes(root, p, [], out);
      else walk(p, depth + 1);
    }
  };
  walk(root, 0);
  const seen = new Set<string>();
  return out
    .filter((r) => !seen.has(r.path) && !!seen.add(r.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, MAX_ROUTES);
}

// ---------- matching (pure) ----------

const segsOf = (p: string) =>
  p
    .trim()
    .replace(/[?#].*$/, "")
    .split("/")
    .filter(Boolean);

const decode = (seg: string) => {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
};
const dynamic = (seg: string) => /^\[.+\]$/.test(seg);
const catchAll = (seg: string) => /^\[\.\.\..+\]$/.test(seg);
const optionalCatchAll = (seg: string) => /^\[\[\.\.\..+\]\]$/.test(seg);

// does a concrete path (or one still holding [param]s) land on this route?
export function routeMatches(route: string, p: string): boolean {
  const r = segsOf(route);
  const s = segsOf(p);
  for (let i = 0; i < r.length; i++) {
    if (optionalCatchAll(r[i])) return true;
    if (catchAll(r[i])) return s.length > i;
    if (i >= s.length) return false;
    if (dynamic(r[i])) continue;
    if (r[i].toLowerCase() !== decode(s[i]).toLowerCase()) return false;
  }
  return r.length === s.length;
}

const statics = (r: string) => segsOf(r).filter((x) => !dynamic(x)).length;
export const matchRoute = (p: string, routes: string[]): string | undefined => {
  // a static route wins over a dynamic one ("/new" over "/[id]"), then the one with more static segments
  const hits = routes.filter((r) => routeMatches(r, p));
  return hits.find((r) => !r.includes("[")) ?? hits.sort((a, b) => statics(b) - statics(a))[0];
};

const stem = (t: string) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);
const tokens = (segs: string[]) =>
  new Set(segs.filter((x) => !dynamic(x)).flatMap((x) => x.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem)));
const meets = (a: Set<string>, b: Set<string>) => [...a].some((t) => b.has(t));

// A route's fit for a path, or undefined when it can't be a confident pick. A route with params needs the
// path's shape: same length, static segments lining up position by position, each param filled from the
// path's segment at its spot (a real value: not a [param], not one of the route's own words). Then every
// path word is covered by the route, and the route says little more (same words, or >= 2 shared and
// Jaccard >= 2/3).
function fit(s: string[], route: string): { to: string; score: number } | undefined {
  const rs = segsOf(route);
  const params = rs.some(dynamic);
  let filled = rs;
  if (params) {
    if (s.length !== rs.length || rs.some((x) => catchAll(x) || optionalCatchAll(x))) return undefined;
    const own = tokens(rs);
    filled = [];
    for (let i = 0; i < rs.length; i++) {
      if (!dynamic(rs[i])) {
        if (!meets(tokens([s[i]]), tokens([rs[i]]))) return undefined;
        filled.push(rs[i]);
      } else {
        if (dynamic(s[i]) || meets(tokens([s[i]]), own)) return undefined;
        filled.push(s[i]);
      }
    }
  }
  const mine = params ? s.filter((_, i) => !dynamic(rs[i])) : s;
  const want = tokens(mine);
  const have = tokens(rs);
  if (!want.size || ![...want].every((t) => have.has(t))) return undefined;
  const common = want.size;
  const score = common / new Set([...want, ...have]).size;
  if (have.size !== want.size && (common < 2 || score < 2 / 3)) return undefined;
  return { to: join(filled), score };
}

// Closest route, only when it's a confident pick (see fit) and no other route ties it; else undefined, and
// the criterion is marked unverified rather than moved to a wrong screen.
export function snapRoute(p: string, routes: string[]): string | undefined {
  const s = segsOf(p);
  const scored = routes.flatMap((r) => fit(s, r) ?? []).sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (!best || (next && next.score === best.score)) return undefined;
  return best.to;
}

export type RouteVerdict = { kind: "ok"; route: string } | { kind: "snap"; to: string } | { kind: "weak"; why: string } | { kind: "unknown" };

// a hit on a route with params that only a param carries: a root-level [team] / [[...slug]] alone, or a
// param filled with a word the app uses as a static segment ("/campaigns" on "/[team]")
function weakHit(p: string, route: string, routes: string[]): boolean {
  const rs = segsOf(route);
  if (!rs.some(dynamic)) return false;
  if (!rs.some((x) => !dynamic(x))) return true;
  const s = segsOf(p);
  const words = tokens(routes.flatMap(segsOf));
  const at = rs.findIndex((x) => catchAll(x) || optionalCatchAll(x));
  const vals = s.filter((_, i) => (at >= 0 && i >= at) || (i < rs.length && dynamic(rs[i])));
  return vals.some((v) => meets(tokens([decode(v)]), words));
}

// one startPath against the scanned routes: ok, a confident snap, weak (a param-only hit, or an unfilled
// [param] the test would open literally) or unknown
export function checkPath(p: string, routes: string[]): RouteVerdict {
  if (segsOf(p).some(dynamic)) return { kind: "weak", why: "has an unfilled [param]" };
  const hit = matchRoute(p, routes);
  if (hit && !weakHit(p, hit, routes)) return { kind: "ok", route: hit };
  const to = snapRoute(p, routes);
  const v = to && !segsOf(to).some(dynamic) ? matchRoute(to, routes) : undefined;
  if (to && v && !weakHit(to, v, routes)) return { kind: "snap", to };
  return hit ? { kind: "weak", why: `only matches ${hit}` } : { kind: "unknown" };
}
