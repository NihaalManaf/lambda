// Core domain model. Every viz is attached to a Feature.

export type FeatureStatus = "shaping" | "ready" | "building" | "verifying" | "done";

export interface ContextRef {
  id: string;
  kind: "slack" | "linear" | "session" | "note";
  title: string;
  excerpt: string; // short, never a wall of text
  url?: string;
  auto?: boolean; // attached by auto-discovery (rediscover may replace it); false/undefined = pinned by a person
  score?: number; // 0-1 relevance from discovery
  why?: string; // <= 8 words, why it's relevant
}

// ---------- background generation ----------

// feature-level jobs live on feature.jobs; piece-level jobs live on piece.jobs
export type FeatureJobKind = "intake" | "context" | "pieces";
export type PieceJobKind = "facts" | "stories" | "flows" | "schema" | "queues" | "needs" | "sketch" | "check";
export type JobKind = FeatureJobKind | PieceJobKind;
export const FEATURE_JOB_KINDS: FeatureJobKind[] = ["intake", "context", "pieces"];
export const PIECE_JOB_KINDS: PieceJobKind[] = ["facts", "stories", "flows", "schema", "queues", "needs", "sketch", "check"];
export const isFeatureJobKind = (k: string): k is FeatureJobKind => (FEATURE_JOB_KINDS as string[]).includes(k);
export type JobStatus = "queued" | "running" | "done" | "error";

export interface Job {
  kind: JobKind;
  status: JobStatus;
  error?: string; // short
  note?: string; // short, a done job's caveat (e.g. sketch: "skipped /admin — login failed")
  startedAt?: string;
  finishedAt?: string;
  pid?: number; // owning server process, for the stale sweep
}

// which per-feature visualizers apply (schema = db tables/columns, queues = async jobs/queues/crons)
export interface FeatureNeeds {
  schema: boolean;
  queues: boolean;
  why: string; // <= 12 words
}

// per-source status from the last context discovery
export interface DiscoveryStatus {
  at: string;
  queries: string[];
  sources: { kind: ContextRef["kind"]; ok: boolean; found: number; error?: string }[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  notes?: import("./ops").ChangeNote[];
  error?: string; // assistant turn that failed or was stopped
  undone?: boolean; // its changes were rolled back with "undo turn"
  source?: "intake" | "edit" | "code"; // intake conversation, edit chat, or an answer from the codebase session
  ask?: { question: string; options: string[]; multi?: boolean }; // rendered as option chips
  at: string;
}

// The last chat turn's pre-change state, so one tap can roll the whole turn back.
// `after` fingerprints the same fields right after the turn: undo is refused once anything else changed them.
export interface ChatUndo {
  turnId: string;
  before: Pick<Feature, "title" | "brief" | "context" | "contextDismissed" | "pieces" | "issues">;
  after: string;
}

// legacy (pre-pieces) sizing: only read by migrateFeature (src/lib/pieces.ts)
export interface Slice {
  id: string;
  title: string; // <= 6 words
  why: string; // <= 15 words
  storyIds: string[];
}

export interface Sizing {
  verdict: "one-piece" | "split";
  reason: string; // <= 20 words
  slices: Slice[]; // ordered: build sequentially
}

// ---------- flowcharts ----------

export type FlowLens = "customer-journey" | "data" | "infra" | "state" | "custom";

export type FlowNodeKind = "start" | "step" | "decision" | "end" | "error" | "external" | "store";

export interface FlowNode {
  description?: string;
  id: string;
  label: string; // <= 5 words
  kind: FlowNodeKind;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  label?: string; // <= 3 words, used on decision branches
}

export interface EdgeCase {
  id: string;
  nodeId: string;
  text: string; // <= 12 words
  handled: boolean | null; // null = unknown, needs a decision
}

export interface FlowSchedule {
  nodeId: string;
  job: string;
  timing: string;
  expression: string | null;
  timezone: string | null;
  source: string | null;
}

export interface Flowchart {
  id: string;
  title: string;
  summary: string; // <= 12 words
  schedules?: FlowSchedule[];
  nodes: FlowNode[]; // hard cap: MAX_FLOW_NODES
  edges: FlowEdge[];
  edgeCases: EdgeCase[];
}

export interface FlowchartSet {
  id: string;
  lens: FlowLens;
  title: string;
  charts: Flowchart[]; // a big flow is broken into several small charts
  createdAt: string;
}

export const MAX_FLOW_NODES = 9;
// lenses the background "flows" job draws for every new feature (src/lib/jobs.ts)
export const AUTO_LENSES: FlowLens[] = ["customer-journey", "data"];
// drawn too once the needs check flags backend / async work (queues or schema)
export const INFRA_LENS: FlowLens = "infra";
export const autoLenses = (f: Pick<PieceArtifacts, "needs">): FlowLens[] =>
  f.needs?.queues || f.needs?.schema ? [...AUTO_LENSES, INFRA_LENS] : AUTO_LENSES;

// ---------- UI mockups ----------

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DomBox extends Box {
  idx: number;
  tag: string;
  text: string;
  role?: string;
  floating?: boolean; // small position:fixed widget (fab, chat bubble, toast): drawn over the page, not part of its flow
}

export type AnnotationKind = "insert" | "remove" | "move" | "change-text" | "restyle" | "note";

export interface Annotation {
  id: string;
  kind: AnnotationKind;
  box: Box; // in screenshot pixel coords
  label: string; // <= 6 words, shown in marker handwriting
  detail?: string; // <= 20 words
  to?: Box; // for "move"
  newText?: string; // for "change-text"
}

export interface Mockup {
  id: string;
  url: string;
  title: string;
  shot: string; // filename under data/shots
  width: number;
  height: number;
  fold?: number; // viewport height at capture: the first screen
  elements: DomBox[];
  annotations: Annotation[];
  intent?: string; // last sketch intent
  thumb?: string; // thumbnail filename under data/shots
  auto?: boolean; // drawn by the background sketch job (a re-run replaces it unless edited); manual captures never are
  edited?: boolean; // a person changed an auto sketch's marks / re-sketched it: re-runs keep it
  createdAt: string;
}

// ---------- user stories ----------

export type Priority = "must" | "should" | "could";

export interface Acceptance {
  id: string;
  given: string;
  when: string;
  then: string;
  startPath: string; // route the browser test starts at: one of the app's real routes
  steps: string[]; // concrete browser steps, each <= 12 words
  unverified?: string; // check stage: why it isn't backed by the code (unknown route, contradicted). an edit clears it
}

export type StoryStatus = "todo" | "building" | "passing" | "failing";

export interface Story {
  id: string;
  role: string;
  want: string;
  soThat: string;
  priority: Priority;
  sliceId?: string; // legacy, unused (pieces replaced slices)
  acceptance: Acceptance[];
  status: StoryStatus;
}

// ---------- verification ----------

export type RunStatus = "queued" | "running" | "passed" | "failed" | "error";

export interface VerificationRun {
  id: string;
  storyId: string;
  accountId?: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  log: string[];
  summary?: string;
  failures?: string[]; // short, one per failed check
  shots: string[];
}

// ---------- schema + queue viz (shared) ----------

export type DiffState = "added" | "removed" | "changed" | "renamed" | "same" | "context";
export type RiskLevel = "bad" | "warn" | "info";
export type IconName =
  | "key" | "link" | "lock" | "bolt" | "index" | "eye" | "bucket" | "clock" | "retry" | "delay" | "dedup"
  | "flow" | "callback" | "shield" | "queue" | "cron" | "globe" | "file" | "warn" | "code" | "loop" | "split";
export interface Badge {
  icon: IconName;
  text?: string; // <= 6 chars
  tone?: "ok" | "warn" | "bad" | "muted";
  title: string; // <= 8 words
}
export interface Risk {
  id: string;
  rule: string;
  level: RiskLevel;
  label: string; // <= 3 words
  why: string; // <= 12 words
  target: { kind: "table" | "column" | "node" | "edge" | "migration"; id: string; col?: string };
}

// ---------- feature → pieces ----------

export type FeaturePhase = "intake" | "shaping" | "ready"; // intake = conversation in progress

// build = shape a new feature (default). understand = explain an EXISTING feature as it works today.
export type FeatureMode = "build" | "understand";
// absent (pre-mode data) or anything unknown reads as build
export const featureMode = (f: { mode?: FeatureMode | string } | null | undefined): FeatureMode =>
  f?.mode === "understand" ? "understand" : "build";

// Everything built for one shippable PR.
export interface PieceArtifacts {
  stories: Story[];
  flowcharts: FlowchartSet[];
  mockups: Mockup[];
  runs: VerificationRun[];
  schema?: import("./schema/types").SchemaProposal[];
  queues?: import("./queues/types").QueueProposal[];
  needs?: FeatureNeeds;
}

// A piece = one shippable PR. Ship-as-one = exactly one piece.
export interface Piece extends PieceArtifacts {
  id: string; // "pc_xxx"
  order: number; // 1-based build order
  title: string; // <= 6 words
  why: string; // <= 15 words
  scope?: string[]; // from the brief: what this PR covers
  status: FeatureStatus;
  jobs?: Job[]; // piece-level jobs (PieceJobKind)
  schemaFocus?: SchemaFocus; // understand: the tables it uses today (src/lib/schema/focus.ts)
  facts?: PieceFacts; // read from the code by the "facts" job (src/lib/grounding.ts); grounds stories / flows / needs
  check?: PieceCheck; // last "check" job: stories + flows verified against the code
}

// What a Claude Code session read in the checkout for one piece. Every item cites file(:line).
// understand: as it works today; build: where the change will live + what exists that it builds on.
export interface PieceFacts {
  routes: { path: string; screen: string; labels: string[]; file: string }[];
  endpoints: { method: string; path: string; file: string }[];
  tables: string[];
  gates: { what: string; file: string }[];
  components: { name: string; file: string }[];
  notes: string[];
  appRoutes: string[]; // every frontend route scanned in the checkout (src/lib/routes.ts), [param] kept
  sha: string; // checkout it was read at
  at: string;
  incomplete?: string; // the session failed / was skipped: routes only (a re-run of stories / flows reads again)
}

export interface PieceCheck {
  ok: number;
  fixed: number;
  flagged: number;
  unsure?: number;
  at: string;
  sha?: string;
  note?: string; // e.g. "no codebase — routes not checked"
  // build mode: what the checker found wrong without a one-field fix (understand logs issues instead)
  flags?: { kind: "story" | "criterion" | "node" | "edgeCase"; id: string; why: string; evidence?: string }[];
}

export interface SchemaFocus {
  tables: { id: string; role: string }[]; // schema-qualified, most central first
  sig: string; // replay signature it was picked against
  at: string;
}

// Written by the intake session once the feature is clear.
export interface Brief {
  summary: string; // <= 40 words
  roles: string[];
  inScope: string[]; // each <= 10 words
  outOfScope: string[];
  decisions: { q: string; a: string }[];
  openQuestions: string[];
  surfaces: string[]; // screens/routes/tables/services touched (grounded in the code); understand: where it lives today
  pieces: { title: string; why: string; scope: string[] }[]; // 1..5, ordered; understand: sub-areas in reading order
}

export interface IntakeState {
  sessionId?: string;
  worktree?: string; // the checkout the session ran in
  featureDir?: string; // build: the feature's own checkout dir (kept for removal; worktree may be cleared)
  mainSha?: string; // sha that checkout held when the session read it
  baseSha?: string; // build: the commit the feature's own checkout is pinned at (set once; refresh moves it)
  baseRef?: string; // the base it came from, e.g. origin/<branch> or main (display)
  status: "idle" | "thinking" | "asking" | "ready" | "error";
  error?: string;
}

export interface Feature {
  id: string;
  title: string;
  brief: string; // text (= briefDoc.summary once the intake settles)
  briefDoc?: Brief; // the structured brief from the intake conversation
  phase: FeaturePhase;
  mode?: FeatureMode; // absent = "build" (pre-mode data); fixed at creation
  status: FeatureStatus;
  createdAt: string;
  updatedAt: string;
  context: ContextRef[];
  pieces: Piece[]; // ordered by .order
  intake?: IntakeState;
  jobs?: Job[]; // feature-level jobs (FeatureJobKind)
  discovery?: DiscoveryStatus;
  // auto context the developer detached: never re-attached by rediscover
  contextDismissed?: { kind: ContextRef["kind"]; title: string; url?: string }[];
  chat?: ChatMessage[]; // the ONE thread (intake + edits)
  chatUndo?: ChatUndo;
  // understand: what to fix / extend, collected until a build starts from them (src/lib/issues.ts)
  issues?: Issue[];
  builds?: { featureId: string; issueIds: string[]; at: string }[]; // build features started from issues
  // build: the understand feature (and its issues) this one was started from
  fromFeature?: string;
  issueIds?: string[];
}

export type IssueKind = "bug" | "improvement" | "question";
export type IssueStatus = "open" | "in build" | "dropped";
export type IssueSource = "chat" | "intake" | "manual" | "pin" | "verify" | "check";
// what an issue was flagged on: a story, flow node / edge case, mockup mark, schema table or verify run
export interface IssueRef {
  tab: "stories" | "flows" | "sketch" | "schema" | "verify";
  id: string;
  label: string;
}
export interface Issue {
  id: string; // "is_xxx"
  title: string; // <= 10 words
  detail?: string;
  kind: IssueKind;
  status: IssueStatus;
  source: IssueSource;
  ref?: IssueRef;
  pieceId?: string;
  createdAt: string;
  build?: string; // the build feature it went into
}

// Projection of one piece onto a Feature-shaped object (src/lib/pieces.ts pieceView): tabs, generators
// and ops keep reading feature.stories / .flowcharts / …; jobs = feature-level + this piece's.
// Every /api/features/[id]/* route returns one of these (a superset of Feature).
export type FeatureView = Feature & PieceArtifacts & { pieceId: string; sizing?: undefined };

// ---------- settings ----------

export interface TestAccount {
  id: string;
  label: string;
  loginUrl: string;
  email: string;
  password: string;
  notes?: string;
}

export interface Settings {
  envPath: string; // BYOK source, e.g. ~/code/my-app/.env ("" = process env)
  frontendUrl: string; // the real app we sketch over + test against
  repoPath: string; // where claude code runs for builds/tests
  edgeCases?: boolean; // flowchart edge cases (unhappy paths pinned to nodes); false = never drawn or shown. absent = on
  baseBranch: string; // branch lambda reads code from, e.g. <remote>/<branch> (fetched first); "" = auto (main / master)
  model: string;
  accounts: TestAccount[];
  migrationsDir: string; // default "migrations"
  extraMigrationDirs: string[]; // default []
  appHosts: string[]; // host fragments that are "our" API (queue urls to these are internal), e.g. ["myapp"]
  baselineSchemaPath: string; // default "" (pg_dump --schema-only file; optional)
  queueIgnore: string[]; // default ["node_modules",".git",".next","venv",".venv","dist","build","__pycache__"]
}

// ---------- local stack (lambda's own copy of the app: frontend + api + queue emulator) ----------

export type StackRole = "frontend" | "api" | "queue" | "worker" | "other";

// cmd: argv array, or one shell line (shell: true) only when it needs `source` / `&&`. cwd relative to the
// repo root. Placeholders (cmd, env, setup): ${port} ${url} (own), ${port.<extra>}, ${port:<svc>},
// ${port:<svc>.<extra>}, ${url:<svc>}, ${repo} (the developer's checkout), ${worktree} (lambda's).
export interface StackService {
  name: string;
  cwd: string;
  cmd: string[] | string;
  shell?: boolean;
  port?: { env?: string; arg?: string }; // inject the allocated port as env var / append `arg <port>`
  extraPorts?: string[]; // more ports this service binds (e.g. qstash's log server)
  ready?: { path?: string; status?: number; log?: string; timeoutSec?: number };
  role: StackRole;
  optional?: boolean; // not started unless asked for by name
}

export interface StackSetup {
  name: string;
  cwd: string;
  cmd: string[] | string;
  shell?: boolean;
  skipIf?: string; // path (relative to cwd) that, when it exists, means the step already ran
}

export interface StackPlan {
  services: StackService[];
  setup: StackSetup[];
  env: Record<string, Record<string, string>>; // service -> KEY -> value (placeholders allowed)
  envFiles: string[]; // gitignored env files to copy from the developer's checkout (relative)
  notes: string[];
}

export interface StackPlanRecord {
  repoPath: string; // realpath of the repo the plan is for
  plan?: StackPlan;
  approved: boolean; // only true while approvedHash matches the stored plan (getPlanRecord enforces it)
  approvedHash?: string; // planHash() of the exact plan the developer approved
  source?: "claude" | "edited";
  sha?: string; // checkout the plan was read from
  createdAt: string;
  updatedAt: string;
  planError?: string;
}

export type StackServiceStatus = "stopped" | "starting" | "ready" | "crashed" | "error";

export interface StackServiceState {
  name: string;
  role: StackRole;
  port?: number;
  extraPorts?: Record<string, number>;
  url?: string;
  pid?: number; // = process group id (spawned detached)
  status: StackServiceStatus;
  startedAt?: string;
  readyAt?: string;
  exitCode?: number | null;
  error?: string;
}

export interface StackState {
  key: string;
  worktree: string;
  repoPath: string;
  ownerPid: number; // the lambda server process that spawned it
  status: "stopped" | "setup" | "starting" | "ready" | "partial" | "error";
  services: StackServiceState[];
  features: string[]; // features that asked for it (info + idle accounting)
  lastUsedAt: string;
  setupPid?: number; // pgid of a running setup step (for the reaper / watchdog)
  error?: string;
  foreign?: boolean; // owned by another live lambda process (installed app vs dev server): read-only here
}
