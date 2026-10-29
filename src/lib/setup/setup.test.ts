import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// own data dir (store.ts reads LAMBDA_DATA_DIR at import): these tests write repoPath/accounts/keys.env,
// which must never leak into the shared vitest store other files read
await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  process.env.LAMBDA_DATA_DIR = fs.mkdtempSync(join(tmpdir(), "lambda-setup-data-"));
});
import { loadEnv, secret } from "@/lib/env";
import { DATA_DIR, getSettings, saveSettings } from "@/lib/store";
import { apply, detect, detectChosen, SetupError, status } from "./index";
import { plan } from "./plan";
import { appHostsFrom, detectRepo, findMigrations, guessLoginUrl, isBotLogin, loginsFrom, packageJsons, portFromScript, siteLabel } from "./repo";
import { dominant, rankRepos, repoRootOf, stripWorktree } from "./repos";
import { setupCtx } from "./ctx";
import type { ToolsReport } from "./tools";

// A fake $HOME: one app repo with sessions + worktrees, one quiet repo, and lambda's own checkout.

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lambda-setup-home-")));
const APP = path.join(HOME, "Documents", "acme");
const QUIET = path.join(HOME, "code", "side-project");
const SELF = path.join(HOME, "Documents", "lambda");
const PROJECTS = path.join(HOME, ".claude", "projects");
const NOW = Date.parse("2026-10-28T12:00:00Z");
const ANTH = "sk-ant-api03-" + "x".repeat(40);

const w = (p: string, body: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

function session(dirName: string, cwd: string, n: number, daysAgo = 1) {
  for (let i = 0; i < n; i++) {
    const f = path.join(PROJECTS, dirName, `s${i}.jsonl`);
    w(f, JSON.stringify({ type: "user", cwd, message: { role: "user", content: "fix the thing please now" } }) + "\n");
    const t = new Date(NOW - daysAgo * 86_400_000 - i * 1000);
    fs.utimesSync(f, t, t);
  }
}

const tools = (over: Partial<ToolsReport> = {}): ToolsReport => ({
  tools: [{ name: "node", installed: true, version: "22.1.0" }],
  claude: { name: "claude", installed: true, version: "2.1.0", auth: { loggedIn: true, authMethod: "claude.ai" } },
  chromium: { installed: true, revision: "1248", headlessShell: true },
  ...over,
});
const ctx = { home: HOME, projectsDir: PROJECTS, selfDir: SELF, probe: false, now: NOW };

beforeAll(() => {
  delete process.env.ANTHROPIC_API_KEY; // "no key anywhere" must mean it
  // the app
  fs.mkdirSync(path.join(APP, ".git"), { recursive: true });
  w(path.join(APP, ".git", "HEAD"), "ref: refs/heads/main\n");
  w(path.join(APP, "package.json"), JSON.stringify({ name: "acme-monorepo", workspaces: ["frontend"] }));
  w(path.join(APP, "frontend", "package.json"), JSON.stringify({ name: "acme-web", scripts: { dev: "next dev -p 3100" }, dependencies: { next: "16", react: "19" } }));
  w(
    path.join(APP, ".env"),
    [
      `ANTHROPIC_API_KEY=${ANTH}`,
      "LINEAR_API_KEY=lin_api_123",
      "API_BASE_URL=https://api.acme.io/v1",
      "STRIPE_WEBHOOK_URL=https://hooks.stripe.com/x",
      "SUPABASE_URL=https://abc.supabase.co",
      "DATABASE_URL=postgres://u:pw@db.internal-acme.com:5432/x",
      "TEST_USER_EMAIL=qa@acme.io",
      "TEST_USER_PASSWORD=hunter2-secret",
      "",
    ].join("\n"),
  );
  w(path.join(APP, ".env.example"), "ANTHROPIC_API_KEY=\nOPENAI_API_KEY=\n");
  w(path.join(APP, ".env.momentic.local"), "ACME_EMAIL=bot@acme.io\nACME_PASSWORD=pw-from-momentic\nDB_PASSWORD=nope\n");
  w(path.join(APP, "frontend", ".env.local"), "NEXT_PUBLIC_SITE_URL=http://localhost:3100\nOPENAI_API_KEY=sk-o\n");
  for (let i = 0; i < 4; i++) w(path.join(APP, "migrations", `00${i}_init.sql`), "create table t(id int);");
  w(path.join(APP, "alerts", "migrations", "001.sql"), "select 1;");
  w(path.join(APP, "node_modules", "x", "migrations", "1.sql"), "select 1;"); // ignored
  // a linked worktree of the app
  const wt = path.join(APP, ".worktrees", "feat-x");
  w(path.join(wt, ".git"), `gitdir: ${path.join(APP, ".git", "worktrees", "feat-x")}\n`);

  // a quiet repo: no sessions, found by the shallow scan
  fs.mkdirSync(path.join(QUIET, ".git"), { recursive: true });
  w(path.join(QUIET, ".git", "HEAD"), "ref: refs/heads/dev\n");
  w(path.join(QUIET, "pyproject.toml"), "[project]\nname='side'\n");

  // lambda itself: lots of sessions, must never be offered
  fs.mkdirSync(path.join(SELF, ".git"), { recursive: true });
  w(path.join(SELF, "package.json"), "{}");

  session("-acme", APP, 6);
  session("-acme-wt", wt, 3, 2);
  session("-acme-gone-wt", path.join(APP, ".worktrees", "deleted-branch", "api"), 2, 3);
  session("-lambda", SELF, 20);
  session("-tmp", "/private/tmp/scratch", 5);
});

afterAll(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("detectors", () => {
  it("maps worktrees (live and deleted) back to the main repo", () => {
    expect(stripWorktree(`${APP}/.claude/worktrees/x/src`)).toBe(APP);
    expect(repoRootOf(path.join(APP, ".worktrees", "feat-x"), HOME)).toBe(APP);
    expect(repoRootOf(path.join(APP, ".worktrees", "deleted-branch", "api"), HOME)).toBe(APP);
    expect(repoRootOf(path.join(APP, "frontend"), HOME)).toBe(APP);
  });

  it("ranks repos by session use, excludes lambda + outside-home cwds", async () => {
    const repos = await rankRepos(setupCtx(ctx));
    expect(repos.map((r) => r.path)).toEqual([APP, QUIET]);
    expect(repos[0]).toMatchObject({ name: "acme", sessions: 11, web: true, branch: "main" });
    expect(repos[1]).toMatchObject({ sessions: 0, web: false, branch: "dev" });
    expect(dominant(repos)?.path).toBe(APP);
  });

  it("reads one repo: env, frontend, migrations, hosts, logins — no secret values", async () => {
    const r = await detectRepo(APP, setupCtx(ctx));
    expect(r.envPath).toBe(path.join(APP, ".env"));
    expect(r.envFiles.map((f) => f.rel).sort()).toEqual([".env", ".env.momentic.local", "frontend/.env.local"]); // .example skipped
    expect(r.envFiles.find((f) => f.rel === ".env")?.keys).toEqual(["ANTHROPIC_API_KEY", "LINEAR_API_KEY"]);
    expect(r.frontend).toEqual({ url: "http://localhost:3100", source: "NEXT_PUBLIC_SITE_URL", up: null });
    expect(r.migrations).toEqual({ dir: "migrations", extra: ["alerts/migrations"], counts: { migrations: 4, "alerts/migrations": 1 } });
    expect(r.appHosts).toEqual(["acme"]);
    expect(r.logins.map((l) => [l.email, l.hasPassword])).toEqual([["qa@acme.io", true], ["bot@acme.io", true]]);
    expect(r.logins[0]).toMatchObject({ label: "test account", loginUrlGuess: "/login", loginUrlSource: null, bot: false });
    expect(r.logins[1]).toMatchObject({ label: "acme ci login", bot: true });
    expect(r.partial).toBe(false);
    const wire = JSON.stringify(r);
    expect(wire).not.toContain("hunter2");
    expect(wire).not.toContain("pw-from-momentic");
    expect(wire).not.toContain(ANTH);
    expect(wire).not.toContain("lin_api_123");
  });

  it("small parsers", () => {
    expect(portFromScript("next dev -p 4000")).toBe(4000);
    expect(portFromScript("vite --port 5174")).toBe(5174);
    expect(portFromScript("PORT=3005 react-scripts start")).toBe(3005);
    expect(portFromScript("next dev")).toBeNull();
    expect(siteLabel("api.foo.com")).toBe("foo");
    expect(siteLabel("app.foo.co.uk")).toBe("foo");
    expect(siteLabel("10.0.0.1")).toBeNull();
    expect(appHostsFrom([{ OPENAI_BASE_URL: "https://api.openai.com", RANDOM: "https://blog.medium.com" }], ["x"])).toEqual([]);
    // integrations named by their own key don't count; the host several redirect/url keys share does
    expect(
      appHostsFrom(
        [{ CELLO_API_URL: "https://api.cello.so", N8N_URL: "https://x1.app.n8n.cloud", PODSCAN_BASE_URL: "https://podscan.fm", GOOGLE_REDIRECT_URI: "https://app.myco.com/cb", NYLAS_REDIRECT_URI: "https://app.myco.com/n" }],
        ["webapp"],
      ),
    ).toEqual(["myco"]);
  });

  it("falls back to framework default port when nothing names one", async () => {
    const r = path.join(HOME, "code", "vite-app");
    fs.mkdirSync(path.join(r, ".git"), { recursive: true });
    w(path.join(r, "package.json"), JSON.stringify({ devDependencies: { vite: "6" } }));
    const rep = await detectRepo(r, setupCtx(ctx));
    expect(rep.frontend?.url).toBe("http://localhost:5173");
    expect(rep.envPath).toBeNull();
    expect(rep.migrations).toBeNull();
    fs.rmSync(r, { recursive: true });
  });
});

describe("hardening", () => {
  const f = (rel: string, vars: Record<string, string>) => ({ path: path.join(HOME, rel), rel, vars });

  it("only login-shaped values become logins: secrets under USER/LOGIN keys never leave the server", () => {
    const ls = loginsFrom([
      f(".env.test", {
        USER_SERVICE_API_KEY: "sk_live_SECRET",
        GOOGLE_LOGIN_CLIENT_SECRET: "GOCSPX-secret",
        TEST_LOGIN_TOKEN: "tok_abcdef",
        AUTH_USER: "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxx",
        DB_USER: "postgres",
        E2E_USERNAME: "qa-runner",
        TEST_EMAIL: "qa@acme.io",
      }),
    ]);
    expect(ls.map((l) => l.email).sort()).toEqual(["qa-runner", "qa@acme.io"]);
    expect(JSON.stringify(ls)).not.toMatch(/SECRET|secret|tok_|sk-ant/);
  });

  it("never pairs an unrelated password (DATABASE_PASSWORD) with a test email", () => {
    const [a] = loginsFrom([f(".env.test", { TEST_EMAIL: "qa@acme.io", DATABASE_PASSWORD: "db-pw" })]);
    expect(a).toMatchObject({ email: "qa@acme.io", hasPassword: false, passKey: "" });
    const [b] = loginsFrom([f(".env.test", { TEST_EMAIL: "qa@acme.io", PASSWORD: "pw", REDIS_PASSWORD: "r" })]);
    expect(b).toMatchObject({ hasPassword: true, passKey: "PASSWORD" });
  });

  it("ranks people above CI bots and labels the bot", () => {
    expect(isBotLogin("dev+ci@gomomentic.com")).toBe(true);
    expect(isBotLogin("ci@acme.io")).toBe(true);
    expect(isBotLogin("abbott@acme.io")).toBe(false);
    expect(isBotLogin("dev@acme.io")).toBe(false);
    const ls = loginsFrom([
      f(".env.momentic.local", { ACME_EMAIL: "me+ci@gomomentic.com", ACME_PASSWORD: "x" }),
      f(".env", { TEST_USER_EMAIL: "me@acme.io" }),
    ]);
    expect(ls.map((l) => [l.email, l.bot, l.label])).toEqual([
      ["me@acme.io", false, "test account"],
      ["me+ci@gomomentic.com", true, "acme ci login"],
    ]);
  });

  it("finds shallow migrations even after a huge earlier subtree", async () => {
    const r = path.join(HOME, "code", "big");
    for (let i = 0; i < 150; i++) fs.mkdirSync(path.join(r, "aaa", `d${i}`, "x", "y"), { recursive: true });
    for (let i = 0; i < 4500; i++) w(path.join(r, "aaa", `f${i}.txt`), "");
    w(path.join(r, "migrations", "001.sql"), "select 1;");
    expect((await findMigrations(r))?.dir).toBe("migrations");
    fs.rmSync(r, { recursive: true });
  });

  it("infers the login route from the web package, ignoring api routes and admin apps", async () => {
    const r = path.join(HOME, "code", "routes");
    w(path.join(r, "frontend", "package.json"), JSON.stringify({ dependencies: { next: "16" } }));
    fs.mkdirSync(path.join(r, "frontend", "src", "app", "(auth)", "signin"), { recursive: true });
    fs.mkdirSync(path.join(r, "frontend", "src", "app", "api", "login"), { recursive: true });
    w(path.join(r, "admin", "package.json"), JSON.stringify({ dependencies: { next: "16" } }));
    fs.mkdirSync(path.join(r, "admin", "src", "app", "login"), { recursive: true });
    w(path.join(r, "spa", "package.json"), JSON.stringify({ dependencies: { vite: "6" } }));
    w(path.join(r, "spa", "src", "pages", "log-in.tsx"), "export default 1");
    const pkgs = await packageJsons(r);
    expect(await guessLoginUrl(r, pkgs, null)).toEqual({ url: "/signin", source: "frontend/src/app/(auth)/signin" });
    expect(await guessLoginUrl(r, pkgs.filter((p) => p.dir.endsWith("spa")), null)).toEqual({ url: "/log-in", source: "spa/src/pages/log-in.tsx" });
    expect(await guessLoginUrl(r, [], null)).toEqual({ url: "/login", source: null });
    fs.rmSync(r, { recursive: true });
  });

  it("never roots a repo outside home (absolute worktree gitdir, ../ in a cwd)", () => {
    const wt = path.join(HOME, "wt", "app");
    w(path.join(wt, ".git"), "gitdir: /Volumes/SSD/app/.git/worktrees/app\n");
    w(path.join(wt, "package.json"), "{}");
    expect(repoRootOf(wt, HOME)).toBe(wt);
    expect(repoRootOf(`${HOME}/../../opt/app`, HOME)).toBeNull();
    fs.rmSync(path.join(HOME, "wt"), { recursive: true });
  });
});

describe("planner", () => {
  it("dominant repo with key + login: only the optional login question", async () => {
    const d = await detect(ctx, { tools: async () => tools() });
    expect(d.chosen).toBe(APP);
    expect(d.plan.questions.map((q) => q.id)).toEqual(["testLogin"]);
    expect(d.plan.patch).toEqual({
      repoPath: APP,
      envPath: path.join(APP, ".env"),
      frontendUrl: "http://localhost:3100",
      migrationsDir: "migrations",
      extraMigrationDirs: ["alerts/migrations"],
      appHosts: ["acme"],
    });
    expect(d.plan.actions).toEqual([]);
    expect(JSON.stringify(d)).not.toContain("hunter2");
  });

  it("asks for the repo when nothing dominates, and the key when none exists anywhere", () => {
    const repos = [
      { path: "/a", name: "a", sessions: 2, lastUsed: null, web: true, branch: "main", score: 1 },
      { path: "/b", name: "b", sessions: 2, lastUsed: null, web: true, branch: "main", score: 0.9 },
    ];
    expect(dominant(repos)).toBeNull();
    const p = plan({ repos, chosen: null, repo: null, tools: tools({ claude: { name: "claude", installed: true, auth: { loggedIn: false } }, chromium: { installed: false } }), anthropicElsewhere: false, existingAccounts: 0 });
    expect(p.questions.map((q) => q.id)).toEqual(["repo", "anthropicKey"]);
    expect(p.actions.map((a) => a.id)).toEqual(["claudeLogin", "installChromium"]);
  });

  it("asks for a frontend url only when nothing was found; skips login when accounts exist", async () => {
    const r = path.join(HOME, "code", "api-only");
    fs.mkdirSync(path.join(r, ".git"), { recursive: true });
    w(path.join(r, "requirements.txt"), "fastapi\n");
    const out = await detectChosen(r, ctx);
    expect(out?.plan.questions.map((q) => q.id)).toEqual(["anthropicKey", "testLogin", "frontendUrl"]);
    const p = plan({ repos: [], chosen: r, repo: out!.repo, tools: null, anthropicElsewhere: true, existingAccounts: 1 });
    expect(p.questions.map((q) => q.id)).toEqual(["frontendUrl"]);
    fs.rmSync(r, { recursive: true });
  });

  it("rejects paths outside home / non-existent", async () => {
    expect(await detectChosen("/etc", ctx)).toBeNull();
    expect(await detectChosen("relative/path", ctx)).toBeNull();
    expect(await detectChosen(path.join(HOME, "nope"), ctx)).toBeNull();
  });
});

describe("apply + status", () => {
  it("writes settings from detection, copies the login password server-side, stores a pasted key outside the repo", async () => {
    saveSettings({ accounts: [], envPath: "", repoPath: "" });
    const d = await detectChosen(APP, ctx);
    const cand = d!.repo.logins[0];
    const envBefore = fs.readFileSync(path.join(APP, ".env"), "utf8");
    const s = await apply({ repoPath: APP, accountCandidateId: cand.id, anthropicKey: ANTH }, ctx);
    expect(s).toMatchObject({ repoPath: APP, envPath: path.join(APP, ".env"), frontendUrl: "http://localhost:3100", migrationsDir: "migrations", extraMigrationDirs: ["alerts/migrations"], appHosts: ["acme"] });
    expect(s.accounts).toHaveLength(1);
    expect(s.accounts[0]).toMatchObject({ email: "qa@acme.io", password: "hunter2-secret", loginUrl: "/login" });
    // key went to lambda's data dir (0600), the repo is untouched
    const kf = path.join(DATA_DIR, "keys.env");
    expect(fs.statSync(kf).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(APP, ".env"), "utf8")).toBe(envBefore);
    // re-applying the same login upserts instead of duplicating
    const s2 = await apply({ repoPath: APP, accountCandidateId: cand.id }, ctx);
    expect(s2.accounts).toHaveLength(1);
    expect(s2.accounts[0].id).toBe(s.accounts[0].id);
  });

  it("keys.env is the fallback under envPath; status reflects it", async () => {
    const empty = path.join(HOME, "code", "empty.env");
    w(empty, "ANTHROPIC_API_KEY=\nOTHER=1\n");
    saveSettings({ envPath: empty, repoPath: APP });
    expect(secret("ANTHROPIC_API_KEY")).toBe(ANTH); // from keys.env: an empty app value doesn't shadow it
    expect(loadEnv().OTHER).toBe("1");
    const st = await status({ auth: async () => ({ loggedIn: true }), chromium: async () => ({ installed: false }) });
    expect(st).toEqual({ configured: true, missing: [], recommended: ["chromium"] });
    const st2 = await status({ auth: async () => ({ loggedIn: false }), chromium: async () => ({ installed: true }) });
    expect(st2.missing).toEqual(["claudeLogin"]);
    saveSettings({ repoPath: "" });
    // unknown auth (timeout / odd output) isn't "logged out": same rule as the planner
    expect((await status({ auth: async () => null, chromium: async () => ({ installed: true }) })).missing).toEqual(["repo"]);
  });

  it("validates input", async () => {
    await expect(apply({ repoPath: "/etc" }, ctx)).rejects.toBeInstanceOf(SetupError);
    await expect(apply({ repoPath: APP, envPath: "/etc/hosts" }, ctx)).rejects.toThrow(/envPath/);
    await expect(apply({ repoPath: APP, frontendUrl: "javascript:alert(1)" }, ctx)).rejects.toThrow(/frontendUrl/);
    await expect(apply({ repoPath: APP, migrations: { dir: "../../etc" } }, ctx)).rejects.toThrow(/migrations/);
    await expect(apply({ repoPath: APP, anthropicKey: "nope" }, ctx)).rejects.toThrow(/Anthropic/);
    await expect(apply({ repoPath: APP, accountCandidateId: "0000000000000000" }, ctx)).rejects.toThrow(/test login/);
    const s = await apply({ repoPath: APP, appHosts: ["Acme", "bad host!", "x"], migrations: { dir: "", extra: [] } }, ctx);
    expect(s.appHosts).toEqual(["acme"]);
    expect(s.migrationsDir).toBe("");
    expect(getSettings().repoPath).toBe(APP);
  });
});
