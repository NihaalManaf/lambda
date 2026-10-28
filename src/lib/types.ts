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

export type JobKind = "context" | "stories" | "flows" | "schema" | "queues";
export type JobStatus = "queued" | "running" | "done" | "error";

export interface Job {
  kind: JobKind;
  status: JobStatus;
  error?: string; // short
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
  at: string;
}

// The last chat turn's pre-change state, so one tap can roll the whole turn back.
// `after` fingerprints the same fields right after the turn: undo is refused once anything else changed them.
export interface ChatUndo {
  turnId: string;
  before: Pick<Feature, "title" | "brief" | "stories" | "sizing" | "context" | "contextDismissed" | "flowcharts">;
  after: string;
}

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

export interface Flowchart {
  id: string;
  title: string;
  summary: string; // <= 12 words
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
export const autoLenses = (f: Pick<Feature, "needs">): FlowLens[] =>
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
  elements: DomBox[];
  annotations: Annotation[];
  intent?: string; // last sketch intent
  thumb?: string; // thumbnail filename under data/shots
  createdAt: string;
}

// ---------- user stories ----------

export type Priority = "must" | "should" | "could";

export interface Acceptance {
  id: string;
  given: string;
  when: string;
  then: string;
  startPath: string; // route the browser test starts at, e.g. "/campaigns"
  steps: string[]; // concrete browser steps, each <= 12 words
}

export type StoryStatus = "todo" | "building" | "passing" | "failing";

export interface Story {
  id: string;
  role: string;
  want: string;
  soThat: string;
  priority: Priority;
  sliceId?: string;
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

// ---------- feature ----------

export interface Feature {
  id: string;
  title: string;
  brief: string;
  status: FeatureStatus;
  createdAt: string;
  updatedAt: string;
  context: ContextRef[];
  sizing?: Sizing;
  flowcharts: FlowchartSet[];
  mockups: Mockup[];
  stories: Story[];
  runs: VerificationRun[];
  schema?: import("./schema/types").SchemaProposal[];
  queues?: import("./queues/types").QueueProposal[];
  jobs?: Job[];
  needs?: FeatureNeeds;
  discovery?: DiscoveryStatus;
  // auto context the developer detached: never re-attached by rediscover
  contextDismissed?: { kind: ContextRef["kind"]; title: string; url?: string }[];
  chat?: ChatMessage[];
  chatUndo?: ChatUndo;
}

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
  model: string;
  accounts: TestAccount[];
  migrationsDir: string; // default "migrations"
  extraMigrationDirs: string[]; // default []
  appHosts: string[]; // host fragments that are "our" API (queue urls to these are internal), e.g. ["myapp"]
  baselineSchemaPath: string; // default "" (pg_dump --schema-only file; optional)
  queueIgnore: string[]; // default ["node_modules",".git",".next","venv",".venv","dist","build","__pycache__"]
}
