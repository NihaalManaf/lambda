import "server-only";
import { z } from "zod";
import { generate } from "./llm";
import { createFeature, getFeature, id, now, updateFeature } from "./store";
import { featureMode, type Feature, type Issue, type IssueKind, type IssueRef, type IssueSource } from "./types";

// Understand mode collects what to fix / extend while reading a feature: from the chat (log_issue), the
// intake session (lambda-issue blocks), by hand, pinned on an artifact, or from a failed verify run. They
// stay "open" until a build starts from some of them: a NEW build feature, linked both ways; the issues
// move to "in build" (never deleted), and the understand map stays as the build's context.

export type NewIssue = { title: string; detail?: string; kind?: IssueKind; ref?: IssueRef; pieceId?: string };

const KINDS: IssueKind[] = ["bug", "improvement", "question"];
const TABS: IssueRef["tab"][] = ["stories", "flows", "sketch", "schema", "verify"];
const clip = (s: string, n: number) => s.trim().replace(/\s+/g, " ").slice(0, n);
const words = (s: string, n: number) => s.trim().split(/\s+/).filter(Boolean).slice(0, n).join(" ");

// untrusted input (api body, model output) → a clean NewIssue, or null
export function cleanIssue(raw: unknown): NewIssue | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" ? words(clip(r.title, 200), 10) : "";
  if (!title) return null;
  const detail = typeof r.detail === "string" ? r.detail.trim().slice(0, 2000) : "";
  const kind = KINDS.includes(r.kind as IssueKind) ? (r.kind as IssueKind) : "improvement";
  const ref = r.ref as Partial<IssueRef> | undefined;
  const okRef =
    ref && TABS.includes(ref.tab as IssueRef["tab"]) && typeof ref.id === "string" && /^[\w.:-]{1,128}$/.test(ref.id)
      ? { tab: ref.tab as IssueRef["tab"], id: ref.id, label: clip(typeof ref.label === "string" ? ref.label : ref.id, 80) }
      : undefined;
  const pieceId = typeof r.pieceId === "string" && /^[\w-]{1,64}$/.test(r.pieceId) ? r.pieceId : undefined;
  return { title, ...(detail && { detail }), kind, ...(okRef && { ref: okRef }), ...(pieceId && { pieceId }) };
}

// mutates f; skips exact duplicates of an issue that's still open (a re-logged chat issue, a double click)
export function addIssues(f: Feature, inputs: NewIssue[], source: IssueSource): Issue[] {
  const list = (f.issues ??= []);
  const added: Issue[] = [];
  for (const i of inputs) {
    const dup = list.some((x) => x.status === "open" && x.title.toLowerCase() === i.title.toLowerCase() && x.ref?.id === i.ref?.id);
    if (dup) continue;
    const issue: Issue = { id: id("is"), title: i.title, kind: i.kind ?? "improvement", status: "open", source, createdAt: now(), ...pick(i) };
    list.push(issue);
    added.push(issue);
  }
  return added;
}
const pick = (i: NewIssue) => ({ ...(i.detail && { detail: i.detail }), ...(i.ref && { ref: i.ref }), ...(i.pieceId && { pieceId: i.pieceId }) });

export async function logIssues(fid: string, inputs: NewIssue[], source: IssueSource): Promise<{ feature: Feature; added: Issue[] }> {
  let added: Issue[] = [];
  const feature = await updateFeature(fid, (f) => {
    if (featureMode(f) !== "understand") throw new Error("issues are collected in understand mode");
    added = addIssues(f, inputs, source);
  });
  return { feature, added };
}

export type IssuePatch = { title?: string; detail?: string; kind?: IssueKind; status?: "open" | "dropped" };

export function patchIssue(fid: string, iid: string, p: IssuePatch): Promise<Feature> {
  return updateFeature(fid, (f) => {
    const i = f.issues?.find((x) => x.id === iid);
    if (!i) throw new Error("issue not found");
    if (p.title !== undefined) {
      const t = words(clip(p.title, 200), 10);
      if (t) i.title = t;
    }
    if (p.detail !== undefined) {
      const d = p.detail.trim().slice(0, 2000);
      if (d) i.detail = d;
      else delete i.detail;
    }
    if (p.kind && KINDS.includes(p.kind)) i.kind = p.kind;
    // "in build" is set by a build only; drop / restore never pull an issue out of one
    if (p.status && i.status !== "in build") i.status = p.status;
  });
}

export function deleteIssue(fid: string, iid: string): Promise<Feature> {
  return updateFeature(fid, (f) => {
    const before = f.issues?.length ?? 0;
    f.issues = (f.issues ?? []).filter((x) => x.id !== iid);
    if (f.issues.length === before) throw new Error("issue not found");
  });
}

// ---------- build from issues ----------

const BuildOut = z.object({
  title: z.string().describe("<= 6 words, what the build changes"),
  brief: z.string().describe("<= 80 words: what to fix / extend and why, grounded in the issues"),
});

export const issueLine = (i: Issue) =>
  `- [${i.kind}] ${i.title}${i.ref ? ` (on ${i.ref.tab} "${i.ref.label}")` : ""}${i.detail ? ` — ${clip(i.detail, 300)}` : ""}`;

// the build intake starts from this brief; the understand map rides along as a context note
export async function buildFromIssues(fid: string, issueIds: string[]): Promise<Feature> {
  const src = getFeature(fid);
  if (!src) throw new Error("feature not found");
  if (featureMode(src) !== "understand") throw new Error("builds start from an understand feature");
  const picked = (src.issues ?? []).filter((i) => issueIds.includes(i.id) && i.status === "open");
  if (!picked.length) throw new Error("pick at least one open issue");
  const lines = picked.map(issueLine).join("\n");
  let title = "";
  let brief = "";
  try {
    const out = await generate({
      schema: BuildOut,
      effort: "low",
      system: "you turn issues found while reading an existing feature into the title and brief of ONE change that fixes / extends it. plain words, no fluff.",
      prompt: `existing feature: ${src.title}\n${src.brief}\n\nissues to address:\n${lines}`,
    });
    title = words(out.title, 6);
    brief = out.brief.trim();
  } catch {
    // no model: the issues themselves are the brief
  }
  title ||= words(picked.length === 1 ? picked[0].title : `${src.title}: ${picked.length} fixes`, 8);
  brief = `${brief ? `${brief}\n\n` : ""}issues (from "${src.title}"):\n${lines}`.slice(0, 4000);

  const created = await createFeature(title.slice(0, 200), brief, "intake", "build");
  const ids = picked.map((i) => i.id);
  const built = await updateFeature(created.id, (f) => {
    f.fromFeature = src.id;
    f.issueIds = ids;
    f.context = [
      {
        id: id("cx"),
        kind: "note",
        title: `understand map: ${clip(src.title, 60)}`,
        excerpt: clip(`how it works today (brief, stories, flows, schema, mockups) is mapped in lambda feature ${src.id}. ${src.brief}`, 600),
        url: `/f/${src.id}`,
      },
    ];
  });
  await updateFeature(src.id, (f) => {
    for (const i of f.issues ?? []) if (ids.includes(i.id) && i.status === "open") Object.assign(i, { status: "in build", build: built.id });
    (f.builds ??= []).push({ featureId: built.id, issueIds: ids, at: now() });
  });
  return built;
}
