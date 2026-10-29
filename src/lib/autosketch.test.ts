import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LAMBDA_DATA_DIR = `${process.env.LAMBDA_DATA_DIR ?? "/tmp/lambda-vitest"}-autosketch`;
});

const generate = vi.fn();
vi.mock("./llm", () => ({ generate: (...a: unknown[]) => generate(...a), featurePrompt: () => "feature" }));
const captureUrl = vi.fn();
vi.mock("./capture", () => ({ captureUrl: (...a: unknown[]) => captureUrl(...a), removeShot: vi.fn() }));
vi.mock("./sketch", () => ({ planSketch: vi.fn(async () => []) }));

import { autoSketch, mergeAutoMockups, nearestParent, normPath, observedRoutes, pickTargets, probeRoutes, shapeTargets, trimNewScreenMarks, type RawTarget } from "./autosketch";
import { makePiece } from "./pieces";
import { getSettings } from "./store";
import type { Feature, Mockup, Story } from "./types";

const story = (id: string, ...paths: string[]): Story => ({
  id,
  role: "admin",
  want: `do ${id}`,
  soThat: "",
  priority: "must",
  status: "todo",
  acceptance: paths.map((startPath, i) => ({ id: `${id}${i}`, given: "", when: "", then: "", startPath, steps: [] })),
});

function feature(): Feature {
  const p1 = makePiece({ title: "send invite", order: 1 });
  p1.stories = [story("a", "/settings/members", "/settings/members/"), story("b", "/members")];
  const p2 = makePiece({ title: "accept", order: 2 });
  p2.stories = [story("c", "/invite/test-token")];
  return { id: "ft_x", title: "team invites", brief: "", phase: "ready", status: "shaping", createdAt: "", updatedAt: "", context: [], pieces: [p1, p2] };
}

const raw = (path: string, intent: string, newScreen = false, parentPath = ""): RawTarget => ({ path, intent, newScreen, parentPath });

const mk = (id: string, url: string, auto?: boolean): Mockup => ({
  id, url, title: id, shot: `${id}.png`, width: 1, height: 1, elements: [], annotations: [], createdAt: "", ...(auto ? { auto } : {}),
});

afterEach(() => {
  vi.restoreAllMocks();
  generate.mockReset();
  captureUrl.mockReset();
});

describe("routes", () => {
  it("normalises paths", () => {
    expect(normPath("/settings/members/")).toBe("/settings/members");
    expect(normPath("settings//members#x")).toBe("/settings/members");
    expect(normPath("http://localhost:3000/a?tab=1")).toBe("/a?tab=1");
    expect(normPath("/")).toBe("/");
    expect(normPath("")).toBe("");
    expect(normPath("javascript:alert(1)")).toBe("");
  });

  it("observes start paths (own piece first, deduped) + hand-captured pages, not auto sketches", () => {
    const f = feature();
    f.pieces[1].mockups = [mk("m", "http://localhost:3000/dashboard"), mk("a", "http://localhost:3000/", true)];
    expect(observedRoutes(f, f.pieces[0])).toEqual(["/settings/members", "/members", "/invite/test-token", "/dashboard"]);
  });

  it("finds the nearest existing parent", () => {
    const allowed = ["/settings/members", "/members", "/"];
    expect(nearestParent("/settings/members/invite", allowed)).toBe("/settings/members");
    expect(nearestParent("/settings/billing", ["/settings/members"])).toBe("/settings/members");
    expect(nearestParent("/teams/new", allowed)).toBe("/");
    expect(nearestParent("/teams/new", ["/members"])).toBeUndefined();
  });
});

describe("shapeTargets", () => {
  const allowed = ["/settings/members", "/members", "/invite/test-token"];

  it("keeps existing routes, trims intents to 15 words, caps at 3", () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
    const out = shapeTargets(
      [raw("/settings/members/", long), raw("/members", "badge"), raw("/invite/test-token", "accept"), raw("/members?x=1", "nope")],
      [...allowed, "/members?x=1"],
    );
    expect(out.map((t) => t.path)).toEqual(["/settings/members", "/members", "/invite/test-token"]);
    expect(out[0].intent.split(" ")).toHaveLength(15);
  });

  it("drops unknown routes unless they are new screens, which move onto their parent", () => {
    const out = shapeTargets(
      [raw("/admin", "secret page"), raw("/settings/members/invite", "invite form", true, "/nowhere"), raw("/teams", "x", true)],
      allowed,
    );
    expect(out).toEqual([
      { path: "/settings/members/invite", newScreen: true, parentPath: "/settings/members", intent: "insert new screen /settings/members/invite: invite form" },
    ]);
  });

  it("dedupes by the page captured (a new screen on a parent already picked)", () => {
    const out = shapeTargets([raw("/settings/members", "invite button"), raw("/settings/members/new", "form", true, "/settings/members")], allowed);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe("/settings/members");
  });

  it("falls back when nothing usable came back", () => {
    const fb = { path: "/members", intent: "x" };
    expect(shapeTargets([raw("/nope", "x")], allowed, fb)).toEqual([fb]);
    expect(shapeTargets([], allowed)).toEqual([]);
  });
});

describe("pickTargets", () => {
  it("asks the model with the known routes and shapes its answer", async () => {
    generate.mockResolvedValue({ targets: [raw("/members", "add pending badge"), raw("/ghost", "x"), raw("/members/invite", "invite modal", true, "/members")] });
    const f = feature();
    const out = await pickTargets(f, f.pieces[0]);
    const prompt = generate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("- /settings/members\n- /members\n- /invite/test-token");
    expect(out).toEqual([{ path: "/members", intent: "add pending badge" }]); // the new screen shares /members
  });

  it("skips the model when no routes are known", async () => {
    const f = feature();
    for (const p of f.pieces) p.stories = [];
    expect(await pickTargets(f, f.pieces[0])).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("mergeAutoMockups", () => {
  it("replaces every unedited auto sketch (stale pages too), keeps hand-edited auto + manual ones, auto first", () => {
    const existing = [
      mk("manual", "http://localhost:3000/members"),
      mk("oldAuto", "http://localhost:3000/members/", true),
      mk("staleAuto", "http://localhost:3000/", true),
      { ...mk("editedAuto", "http://localhost:3000/settings", true), edited: true },
    ];
    const fresh = [mk("new", "http://localhost:3000/members", true)];
    const { mockups, removed } = mergeAutoMockups(existing, fresh);
    expect(mockups.map((m) => m.id)).toEqual(["new", "editedAuto", "manual"]);
    expect(removed.map((m) => m.id)).toEqual(["oldAuto", "staleAuto"]);
  });
});

describe("autoSketch", () => {
  it("app down → 'app not running', no model call, no capture", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const f = feature();
    await expect(autoSketch(f, f.pieces[0])).rejects.toThrow(`app not running at ${getSettings().frontendUrl}`);
    expect(generate).not.toHaveBeenCalled();
    expect(captureUrl).not.toHaveBeenCalled();
  });

  it("captures each target in turn, skips 404 pages, marks results auto", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 200 }));
    generate.mockResolvedValue({ targets: [raw("/members", "badge"), raw("/settings/members", "button")] });
    const base = getSettings().frontendUrl;
    captureUrl
      .mockResolvedValueOnce({ shot: "a.png", url: `${base}/members`, title: "404: This page could not be found.", width: 1, height: 1, elements: [] })
      .mockResolvedValueOnce({ shot: "s.png", url: `${base}/settings/members`, title: "t", width: 1, height: 1, elements: [] });
    const f = feature();
    const { mockups, skipped } = await autoSketch(f, f.pieces[0]);
    expect(captureUrl).toHaveBeenCalledTimes(2);
    expect(mockups).toHaveLength(1);
    expect(mockups[0]).toMatchObject({ auto: true, intent: "button" });
    expect(skipped).toEqual(["skipped /members — page not found"]);
  });

  it("a failed test-account login falls back to signed out once, and says so", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 200 }));
    generate.mockResolvedValue({ targets: [raw("/members", "badge"), raw("/settings/members", "button")] });
    const { saveSettings } = await import("./store");
    saveSettings({ accounts: [{ id: "acct_t", label: "tester", loginUrl: "/signin", email: "a@b.c", password: "x" }] });
    const base = getSettings().frontendUrl;
    const ok = (p: string) => ({ shot: `${p}.png`, url: `${base}${p}`, title: p, width: 1, height: 1, elements: [] });
    captureUrl
      .mockRejectedValueOnce(new Error("login: no password field found"))
      .mockResolvedValueOnce(ok("/members"))
      .mockResolvedValueOnce(ok("/settings/members"));
    const f = feature();
    const { mockups, skipped } = await autoSketch(f, f.pieces[0]);
    expect(captureUrl.mock.calls.map((c) => (c[0] as { accountId?: string }).accountId)).toEqual(["acct_t", undefined, undefined]);
    expect(mockups).toHaveLength(2);
    expect(skipped).toEqual(["tester login failed: no password field found — check the test account in settings · captured signed out"]);
    saveSettings({ accounts: [] });
  });

  it("probes routes: 404 → missing (new screens), anything else exists, the root is not added for free", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) =>
      new Response(null, { status: String(u).endsWith("/members") ? 404 : 307 }),
    );
    expect(await probeRoutes("http://app", ["/members", "/settings"])).toEqual({ existing: ["/settings"], missing: ["/members"] });
  });

  it("new screens go onto a real existing parent, never the bare root", async () => {
    generate.mockResolvedValue({ targets: [raw("/settings/members", "invite button", true, "/")] });
    const f = feature();
    const out = await pickTargets(f, f.pieces[0], { routes: { existing: ["/settings"], missing: ["/settings/members", "/members"] } });
    expect(generate.mock.calls[0][0].prompt).toContain("do NOT exist yet");
    expect(out).toEqual([
      { path: "/settings/members", newScreen: true, parentPath: "/settings", intent: "insert new screen /settings/members: invite button" },
    ]);
  });

  it("every story route 404s → nothing captured (no landing page), a clear note instead", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => new Response(null, { status: new URL(String(u)).pathname === "/" ? 200 : 404 }));
    const f = feature();
    const { mockups, skipped } = await autoSketch(f, f.pieces[0]);
    expect(mockups).toEqual([]);
    expect(skipped).toEqual(["no existing screen for /settings/members yet (404) — sketch after the route exists"]);
    expect(generate).not.toHaveBeenCalled();
    expect(captureUrl).not.toHaveBeenCalled();
  });

  it("a login page that 404s says what to fix", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => new Response(null, { status: String(u).endsWith("/login") ? 404 : 200 }));
    generate.mockResolvedValue({ targets: [raw("/members", "badge")] });
    const { saveSettings } = await import("./store");
    saveSettings({ accounts: [{ id: "acct_t", label: "tester", loginUrl: "/login", email: "a@b.c", password: "x" }] });
    const base = getSettings().frontendUrl;
    captureUrl
      .mockRejectedValueOnce(new Error("login: page.goto: Timeout 30000ms exceeded"))
      .mockResolvedValueOnce({ shot: "m.png", url: `${base}/members`, title: "members", width: 1, height: 1, elements: [] });
    const f = feature();
    const { skipped } = await autoSketch(f, f.pieces[0]);
    expect(skipped).toEqual(["login page /login not found (404) — fix the test account in settings · captured signed out"]);
    saveSettings({ accounts: [] });
  });

  it("an abort stops the capture it is waiting on (signal passed down)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 200 }));
    generate.mockResolvedValue({ targets: [raw("/members", "badge")] });
    let seen: AbortSignal | undefined;
    captureUrl.mockImplementation((o: { signal: AbortSignal }) => ((seen = o.signal), new Promise(() => undefined)));
    const f = feature();
    const outer = new AbortController();
    setTimeout(() => outer.abort(), 30);
    await expect(autoSketch(f, f.pieces[0], { signal: outer.signal })).rejects.toThrow("out of time");
    expect(seen?.aborted).toBe(true);
  });

  it("new-screen marks keep at most one note", () => {
    const a = (id: string, kind: Mockup["annotations"][number]["kind"]) => ({ id, kind, box: { x: 0, y: 0, w: 1, h: 1 }, label: id });
    expect(trimNewScreenMarks([a("n1", "note"), a("i", "insert"), a("n2", "note")]).map((x) => x.id)).toEqual(["n1", "i"]);
  });
});
