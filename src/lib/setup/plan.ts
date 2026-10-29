import type { LoginCandidate, RepoReport } from "./repo";
import type { RepoCandidate } from "./repos";
import type { ToolsReport } from "./tools";

// Pure: detection in → settings patch + the few questions detection couldn't answer.
// Questions come in priority order and each one exists only because something wasn't inferable.

export type SetupPatch = {
  repoPath: string;
  envPath: string;
  frontendUrl: string;
  migrationsDir: string;
  extraMigrationDirs: string[];
  appHosts: string[];
};

export type Question =
  | { id: "repo"; kind: "choice"; prompt: string; options: RepoCandidate[]; default: string | null }
  | { id: "anthropicKey"; kind: "secret"; prompt: string; hint: string }
  | { id: "testLogin"; kind: "account"; optional: true; prompt: string; candidates: LoginCandidate[]; prefill: { candidateId: string | null; label: string; loginUrl: string; email: string } }
  | { id: "frontendUrl"; kind: "url"; prompt: string; default: string };

export type Action = { id: "installClaude" | "claudeLogin" | "installChromium"; blocking: boolean; label: string; hint: string };

export type Inferred = { field: keyof SetupPatch | "testLogin"; value: string; source: string };

export type Plan = { patch: Partial<SetupPatch>; questions: Question[]; actions: Action[]; inferred: Inferred[] };

export type PlanInput = {
  repos: RepoCandidate[];
  chosen: string | null; // repo path the user picked (or the dominant one)
  repo: RepoReport | null; // detection for `chosen`
  tools: ToolsReport | null;
  anthropicElsewhere: boolean; // lambda's keys.env or process env
  existingAccounts: number;
};

export function plan(i: PlanInput): Plan {
  const questions: Question[] = [];
  const actions: Action[] = [];
  const inferred: Inferred[] = [];
  const patch: Partial<SetupPatch> = {};

  // (1) which repo
  if (!i.chosen || !i.repo)
    questions.push({
      id: "repo",
      kind: "choice",
      prompt: i.repos.length ? "Which app should lambda work on?" : "Where's your app's code?",
      options: i.repos,
      default: i.repos[0]?.path ?? null,
    });

  const r = i.repo;
  if (r) {
    patch.repoPath = r.path;
    inferred.push({ field: "repoPath", value: r.path, source: i.repos.find((c) => c.path === r.path)?.sessions ? "your Claude Code sessions" : "picked" });
    patch.envPath = r.envPath ?? "";
    if (r.envPath) inferred.push({ field: "envPath", value: r.envPath, source: `${r.envFiles.find((f) => f.path === r.envPath)?.keys.length ?? 0} known keys` });
    if (r.frontend) {
      patch.frontendUrl = r.frontend.url;
      inferred.push({ field: "frontendUrl", value: r.frontend.url, source: r.frontend.source + (r.frontend.up ? " · running" : r.frontend.up === false ? " · not running now" : "") });
    }
    patch.migrationsDir = r.migrations?.dir ?? "";
    patch.extraMigrationDirs = r.migrations?.extra ?? [];
    if (r.migrations)
      inferred.push({ field: "migrationsDir", value: [r.migrations.dir, ...r.migrations.extra].join(", "), source: `${Object.values(r.migrations.counts).reduce((a, b) => a + b, 0)} .sql files${r.partial ? " · partial scan" : ""}` });
    patch.appHosts = r.appHosts;
    if (r.appHosts.length) inferred.push({ field: "appHosts", value: r.appHosts.join(", "), source: "urls in your env" });
  }

  // (2) anthropic key — only if nowhere to be found
  const keyInRepo = r?.envFiles.some((f) => f.keys.includes("ANTHROPIC_API_KEY")) ?? false;
  if (!keyInRepo && !i.anthropicElsewhere && (r || !i.chosen))
    questions.push({
      id: "anthropicKey",
      kind: "secret",
      prompt: "Paste an Anthropic API key",
      hint: "Kept in lambda's own data folder (0600) — never written into your repo.",
    });

  // (3) test login — optional, prefilled
  if (r && i.existingAccounts === 0) {
    // logins come ranked: people before CI bots, sign-in-able first
    const best = r.logins[0] ?? null;
    if (best) inferred.push({ field: "testLogin", value: best.email, source: best.from });
    questions.push({
      id: "testLogin",
      kind: "account",
      optional: true,
      prompt: best ? "Use this test login?" : "A test login lets lambda see the app signed in (optional)",
      candidates: r.logins,
      prefill: { candidateId: best?.id ?? null, label: best?.label ?? "test account", loginUrl: best?.loginUrlGuess ?? "/login", email: best?.email ?? "" },
    });
  }

  // (4) frontend url — only if nothing found
  if (r && !r.frontend) questions.push({ id: "frontendUrl", kind: "url", prompt: "Where does your app run locally?", default: "http://localhost:3000" });

  // machine
  const t = i.tools;
  if (t) {
    if (!t.claude.installed)
      actions.push({ id: "installClaude", blocking: true, label: "Install Claude Code", hint: "npm install -g @anthropic-ai/claude-code" });
    else if (t.claude.auth && !t.claude.auth.loggedIn)
      actions.push({ id: "claudeLogin", blocking: true, label: "Log in to Claude Code", hint: "Run `claude` in Terminal and follow the login prompt" });
    if (!t.chromium.installed)
      actions.push({ id: "installChromium", blocking: false, label: "Install the test browser", hint: "Downloads Playwright's Chromium (~150 MB)" });
  }

  return { patch, questions, actions, inferred };
}
