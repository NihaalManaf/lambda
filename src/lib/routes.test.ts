import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkPath, matchRoute, routeMatches, scanRoutes, snapRoute } from "./routes";

const tree = (files: string[]) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lambda-routes-"));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), "export default function P() {}\n");
  }
  return root;
};

describe("route scan", () => {
  it("reads a nested next app dir: groups stripped, params kept, api / _private / @slots / intercepts skipped", () => {
    const root = tree([
      "frontend/src/app/layout.tsx",
      "frontend/src/app/page.tsx",
      "frontend/src/app/(dash)/media-database/page.tsx",
      "frontend/src/app/(dash)/media-database/[mediaId]/page.tsx",
      "frontend/src/app/(dash)/settings/(tabs)/billing/page.tsx",
      "frontend/src/app/api/media/route.ts",
      "frontend/src/app/api/page.tsx",
      "frontend/src/app/_components/page.tsx",
      "frontend/src/app/@modal/login/page.tsx",
      "frontend/src/app/(.)photo/page.tsx",
      "frontend/src/app/docs/[[...slug]]/page.mdx",
      "frontend/node_modules/x/app/page.tsx",
      "electron/app/boot.cjs", // an app/ dir without pages isn't a router
    ]);
    const routes = scanRoutes(root);
    expect(routes.map((r) => r.path)).toEqual(["/", "/docs/[[...slug]]", "/media-database", "/media-database/[mediaId]", "/settings/billing"]);
    expect(routes.find((r) => r.path === "/media-database")?.file).toBe(path.join("frontend/src/app/(dash)/media-database/page.tsx"));
  });

  it("reads a pages dir: index → its dir, _app / api skipped", () => {
    const root = tree(["web/pages/_app.tsx", "web/pages/index.tsx", "web/pages/team/[id].tsx", "web/pages/team/index.jsx", "web/pages/api/x.ts", "web/pages/about.mdx"]);
    expect(scanRoutes(root).map((r) => r.path)).toEqual(["/", "/about", "/team", "/team/[id]"]);
  });

  it("a pages dir is a router only with _app / _document or at a next root; components/ and 404 / 500 skipped", () => {
    const root = tree([
      "frontend/package.json",
      "frontend/src/app/campaigns/page.tsx",
      "frontend/src/components/pages/index.ts",
      "frontend/src/components/pages/CampaignsPage.tsx",
      "frontend/src/lib/pages/index.ts",
      "frontend/src/lib/pages/Thing.tsx",
      "site/next.config.mjs",
      "site/pages/index.tsx",
      "site/pages/404.tsx",
      "site/pages/500.tsx",
      "site/pages/pricing.tsx",
    ]);
    fs.writeFileSync(path.join(root, "frontend/package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
    expect(scanRoutes(root).map((r) => r.path)).toEqual(["/", "/campaigns", "/pricing"]);
  });

  it("no next frontend → no routes", () => {
    expect(scanRoutes(tree(["src/main.py", "app/models.py"]))).toEqual([]);
  });
});

describe("route matching", () => {
  const routes = ["/", "/media-database", "/media-database/[mediaId]", "/media-database/new", "/settings/billing", "/docs/[[...slug]]", "/files/[...path]"];

  it("is param-aware; static wins over dynamic", () => {
    expect(matchRoute("/media-database/abc?tab=1", routes)).toBe("/media-database/[mediaId]");
    expect(matchRoute("/media-database/new", routes)).toBe("/media-database/new");
    expect(matchRoute("/media-database/[id]", routes)).toBe("/media-database/[mediaId]");
    expect(matchRoute("/docs", routes)).toBe("/docs/[[...slug]]");
    expect(matchRoute("/docs/a/b", routes)).toBe("/docs/[[...slug]]");
    expect(routeMatches("/files/[...path]", "/files")).toBe(false);
    expect(routeMatches("/files/[...path]", "/files/a/b")).toBe(true);
    expect(matchRoute("/campaigns", routes)).toBeUndefined();
    expect(matchRoute("/Settings/Billing/", routes)).toBe("/settings/billing");
  });

  it("snaps to the closest route only when confident", () => {
    expect(snapRoute("/media", routes)).toBeUndefined(); // a word short of /media-database — not confident
    expect(snapRoute("/medias/database", ["/media-database", "/settings"])).toBe("/media-database");
    expect(snapRoute("/billing/settings", routes)).toBe("/settings/billing");
    expect(snapRoute("/campaigns", routes)).toBeUndefined();
    expect(snapRoute("/media-databases/42", ["/media-database/[mediaId]", "/"])).toBe("/media-database/42");
  });

  it("never snaps onto the wrong screen: params fill only from their own spot, every path word is covered", () => {
    expect(snapRoute("/campaign/new", ["/[team]/campaigns/new"])).toBeUndefined();
    expect(snapRoute("/media", ["/[org]/media-database"])).toBeUndefined();
    expect(snapRoute("/campaign/new", ["/[team]/campaigns/new", "/[team]"])).toBeUndefined();
    expect(snapRoute("/acme/campaign/new", ["/[team]/campaigns/new"])).toBe("/acme/campaigns/new");
    expect(snapRoute("/settings/billing", ["/settings", "/"])).toBeUndefined();
    expect(snapRoute("/users", ["/admin/users"])).toBeUndefined();
    expect(snapRoute("/team/members", ["/settings/team/members"])).toBe("/settings/team/members"); // 2 shared, J 0.67
    expect(snapRoute("/media-databases/[id]", ["/media-database/[mediaId]"])).toBeUndefined();
  });

  it("checkPath: ok / snap / unknown", () => {
    expect(checkPath("/media-database/9", routes)).toEqual({ kind: "ok", route: "/media-database/[mediaId]" });
    expect(checkPath("/docs/a/b", routes)).toEqual({ kind: "ok", route: "/docs/[[...slug]]" });
    expect(checkPath("/billing/settings", routes)).toEqual({ kind: "snap", to: "/settings/billing" });
    expect(checkPath("/campaigns", routes)).toEqual({ kind: "unknown" });
  });

  it("checkPath: a hit only a param carries, or an unfilled [param], is weak", () => {
    const team = ["/[team]", "/[team]/settings", "/[team]/media-database"];
    expect(checkPath("/campaigns", team)).toEqual({ kind: "weak", why: "only matches /[team]" });
    expect(checkPath("/settings", team)).toEqual({ kind: "weak", why: "only matches /[team]" });
    expect(checkPath("/acme/settings", team)).toEqual({ kind: "ok", route: "/[team]/settings" });
    expect(checkPath("/campaigns", ["/[[...slug]]"])).toEqual({ kind: "weak", why: "only matches /[[...slug]]" });
    expect(checkPath("/media-database/settings", ["/media-database/[id]", "/settings"]).kind).toBe("weak"); // a static word as the param
    expect(checkPath("/media-database/[id]", routes)).toEqual({ kind: "weak", why: "has an unfilled [param]" });
  });
});
