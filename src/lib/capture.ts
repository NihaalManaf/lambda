import "server-only";
import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { SHOTS_DIR, getSettings, id } from "./store";
import { AUTH_DIR, authFile, loginHref } from "./auth";
import type { DomBox, TestAccount } from "./types";

// Screenshot the REAL frontend + the visible DOM boxes the sketch planner can point at.

const MAX_HEIGHT = 4000;
const MAX_ELEMENTS = 150;
const NAV_TIMEOUT = 30_000;

export interface Capture {
  shot: string; // filename in SHOTS_DIR
  thumb?: string; // small top crop, same dir
  url: string; // final url after redirects
  title: string;
  width: number;
  height: number;
  elements: DomBox[];
}

const settle = (page: Page, ms = 10_000) => page.waitForLoadState("networkidle", { timeout: ms }).catch(() => undefined);

// ---------- login ----------

async function firstVisible(page: Page, selectors: string[]) {
  for (const s of selectors) {
    const loc = page.locator(s);
    const n = await loc.count();
    for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) return loc.nth(i);
  }
  return null;
}

const USER_INPUTS = [
  'input[type="email"]',
  'input[autocomplete="username"]',
  'input[name*="email" i]',
  'input[name*="user" i]',
  'input[id*="email" i]',
  'input[type="text"]',
];

// base: the origin being captured (lambda's stack or the configured app); a relative loginUrl resolves against it
async function login(ctx: BrowserContext, acc: TestAccount, base: string) {
  const page = await ctx.newPage();
  await page.goto(loginHref(acc, base), { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
  await settle(page, 8000);

  const user = await firstVisible(page, USER_INPUTS);
  if (user) await user.fill(acc.email);
  let pass = await firstVisible(page, ['input[type="password"]']);
  if (!pass && user) {
    // two-step forms (email first, then password)
    await user.press("Enter");
    pass = await page.locator('input[type="password"]').first().waitFor({ timeout: 8000 }).then(
      () => page.locator('input[type="password"]').first(),
      () => null,
    );
  }
  if (!pass) throw new Error("login: no password field found");
  await pass.fill(acc.password);

  const before = page.url();
  const submit = await firstVisible(page, ['button[type="submit"]', 'input[type="submit"]']);
  await (submit ? submit.click() : pass.press("Enter"));
  await page.waitForURL((u) => u.href !== before, { timeout: 15_000 }).catch(() => undefined);
  await settle(page);
  if (await isLoginPage(page, acc, base)) throw new Error("login: still on login page — check test account");

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await ctx.storageState({ path: authFile(acc.id) });
  fs.chmodSync(authFile(acc.id), 0o600);
  await page.close();
}

async function isLoginPage(page: Page, acc: TestAccount, base: string) {
  const loginPath = new URL(loginHref(acc, base)).pathname;
  if (loginPath !== "/" && new URL(page.url()).pathname.startsWith(loginPath)) return true;
  return page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
}

// ---------- DOM boxes ----------

// Runs in the browser. Kept self-contained (no closures over node scope).
function collectBoxes(args: { maxHeight: number; max: number }) {
  const SEL = [
    "button,[role=button],a[href],input,textarea,select,[role=tab],[role=switch],[role=checkbox]",
    "h1,h2,h3,h4,h5,h6",
    "img,svg[role=img],video,canvas,picture",
    "nav,header,footer,aside,form,dialog,[role=dialog],table",
    "section,article,main,[class*=card i],[class*=modal i],li,label",
    "p,blockquote,figcaption",
  ];
  const sy = window.scrollY;
  const vw = document.documentElement.clientWidth;
  type Raw = { x: number; y: number; w: number; h: number; tag: string; text: string; role?: string; tier: number };
  const out: Raw[] = [];
  const seen = new Set<Element>();
  SEL.forEach((sel, tier) => {
    document.querySelectorAll(sel).forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) return;
      const y = r.top + sy;
      if (y > args.maxHeight || r.left > vw || r.right < 0) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.05) return;
      // giant wrappers are noise
      if (tier >= 3 && r.width >= vw * 0.98 && r.height > 1600) return;
      const he = el as HTMLElement;
      const raw =
        (el as HTMLInputElement).placeholder ||
        el.getAttribute("aria-label") ||
        (el as HTMLImageElement).alt ||
        he.innerText ||
        el.textContent ||
        "";
      const text = raw.replace(/\s+/g, " ").trim();
      if (tier === 5 && text.length < 3) return;
      out.push({
        x: Math.max(0, Math.round(r.left)),
        y: Math.round(y),
        w: Math.round(Math.min(r.width, vw - Math.max(0, r.left))),
        h: Math.round(Math.min(r.height, args.maxHeight - y)),
        tag: el.tagName.toLowerCase(),
        text: text.length > 60 ? text.slice(0, 57) + "…" : text,
        role: el.getAttribute("role") || undefined,
        tier,
      });
    });
  });
  return out;
}

// Drop near-duplicate nested boxes (wrapper hugging its only child), keep the more semantic one.
function dedupe(raw: (Omit<DomBox, "idx"> & { tier: number })[]) {
  const sorted = [...raw].sort((a, b) => a.tier - b.tier);
  const kept: typeof raw = [];
  const near = (a: number, b: number) => Math.abs(a - b) <= 6;
  for (const b of sorted) {
    if (kept.some((k) => near(k.x, b.x) && near(k.y, b.y) && near(k.w, b.w) && near(k.h, b.h))) continue;
    kept.push(b);
    if (kept.length >= MAX_ELEMENTS) break;
  }
  return kept
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((b, idx): DomBox => ({ idx, x: b.x, y: b.y, w: b.w, h: b.h, tag: b.tag, text: b.text, role: b.role || undefined }));
}

// ---------- capture ----------

// One browser against the user's app at a time, process-wide (every sketch job + manual captures share it;
// it also keeps two logins from writing the same auth file). On globalThis so HMR keeps one queue.
const G = globalThis as { __lambdaCaptureTail?: Promise<unknown> };

async function exclusive<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = G.__lambdaCaptureTail ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  G.__lambdaCaptureTail = prev.then(() => mine);
  try {
    await new Promise<void>((res, rej) => {
      if (signal?.aborted) return rej(new Error("out of time"));
      const onAbort = () => rej(new Error("out of time"));
      signal?.addEventListener("abort", onAbort, { once: true });
      prev.then(
        () => (signal?.removeEventListener("abort", onAbort), res()),
        () => (signal?.removeEventListener("abort", onAbort), res()),
      );
    });
    return await fn();
  } finally {
    release();
  }
}

// every failure while signing in reads "login: …" (the auto sketch falls back to signed out on those)
const asLogin = (e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(msg.startsWith("login:") ? msg : `login: ${msg.split("\n")[0]}`);
};

// mask data values (emails, phone numbers, long digit runs) before element text is stored or sent to the model
export function maskText(s: string): string {
  return s
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[number]")
    .replace(/\d{5,}/g, "[number]");
}

export function captureUrl(opts: {
  url: string;
  accountId?: string;
  viewport?: { width: number; height: number };
  signal?: AbortSignal; // abort closes the browser; a shot finished after it is removed
}): Promise<Capture> {
  return exclusive(opts.signal, () => captureNow(opts));
}

async function captureNow(opts: Parameters<typeof captureUrl>[0]): Promise<Capture> {
  const viewport = opts.viewport ?? { width: 1280, height: 800 };
  const acc = opts.accountId ? getSettings().accounts.find((a) => a.id === opts.accountId) : undefined;
  if (opts.accountId && !acc) throw new Error(`unknown test account ${opts.accountId}`);
  const aborted = () => {
    if (opts.signal?.aborted) throw new Error("out of time");
  };
  aborted();
  const base = new URL(opts.url).origin;

  const browser = await chromium.launch({ headless: true });
  const onAbort = () => void browser.close().catch(() => undefined);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let shot: string | undefined;
  try {
    aborted();
    const stored = acc && fs.existsSync(authFile(acc.id)) ? authFile(acc.id) : undefined;
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, storageState: stored });
    await ctx.addInitScript("window.__name = window.__name || ((f) => f)"); // esbuild keepNames shim for evaluate()
    if (acc && !stored) await login(ctx, acc, base).catch((e) => Promise.reject(asLogin(e)));

    const page = await ctx.newPage();
    const open = async () => {
      await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      await settle(page);
    };
    await open();
    if (acc && (await isLoginPage(page, acc, base))) {
      await login(ctx, acc, base).catch((e) => Promise.reject(asLogin(e))); // stale session
      await open();
    }

    // nudge lazy content, then back to top
    await page.evaluate(async (max) => {
      const step = window.innerHeight;
      for (let y = 0; y < Math.min(document.body.scrollHeight, max); y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    }, MAX_HEIGHT);
    await settle(page, 4000);
    await page.waitForTimeout(400);

    const fullHeight = await page.evaluate(() =>
      Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
    );
    const height = Math.min(Math.max(fullHeight, viewport.height), MAX_HEIGHT);
    const shotId = id("shot");
    shot = `${shotId}.png`;
    await page.screenshot({
      path: path.join(SHOTS_DIR, shot),
      fullPage: true,
      clip: { x: 0, y: 0, width: viewport.width, height },
      animations: "disabled",
    });

    const raw = await page.evaluate(collectBoxes, { maxHeight: height, max: MAX_ELEMENTS });
    const thumb = await makeThumb(shotId, viewport.width, height);
    aborted();

    return {
      shot,
      thumb,
      url: page.url(),
      title: (await page.title()).slice(0, 80) || new URL(page.url()).pathname,
      width: viewport.width,
      height,
      elements: dedupe(raw).map((e) => ({ ...e, text: maskText(e.text) })),
    };
  } catch (e) {
    if (shot) removeShot(shot);
    throw opts.signal?.aborted ? new Error("out of time") : e;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    await browser.close().catch(() => undefined);
  }
}

async function makeThumb(shotId: string, width: number, height: number) {
  try {
    const sharp = (await import("sharp")).default;
    const name = `${shotId}-thumb.png`;
    await sharp(path.join(SHOTS_DIR, `${shotId}.png`))
      .extract({ left: 0, top: 0, width, height: Math.min(height, Math.round(width * 0.75)) })
      .resize({ width: 360 })
      .png({ compressionLevel: 9 })
      .toFile(path.join(SHOTS_DIR, name));
    return name;
  } catch {
    return undefined;
  }
}

export function removeShot(shot: string) {
  for (const name of [shot, shot.replace(/\.png$/, "-thumb.png")]) {
    if (/^[\w-]+\.png$/.test(name)) fs.rmSync(path.join(SHOTS_DIR, name), { force: true });
  }
}
