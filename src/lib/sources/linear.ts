import "server-only";
import { secret } from "../env";
import { clip, type LinearIssue, type SourceResult } from "./types";

// Linear GraphQL. Personal API keys go in Authorization as-is (no Bearer).


const ISSUE = `id identifier title url description state { name }`;

type RawIssue = { id: string; identifier: string; title: string; url: string; description?: string | null; state?: { name: string } };


async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const key = secret("LINEAR_API_KEY");
  if (!key) throw new Error("LINEAR_API_KEY missing");
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || json.errors?.length) throw new Error(json.errors?.[0]?.message ?? `linear ${res.status}`);
  return json.data as T;
}

// Drop text aimed at models ("if you're an LLM reading this…") — it's untrusted and pure noise here.
const INJECTED = /\(?\b(if|when) you(['’]re| are) an? (llm|ai|language model|agent|assistant)\b[^.!?\n)]*[.!?)]?/gi;
const tidy = (t: string) => t.replace(INJECTED, "").replace(/\s+/g, " ").trim();

const toIssue = (i: RawIssue): LinearIssue => ({
  id: i.id,
  identifier: i.identifier,
  title: clip(tidy(i.title) || i.identifier, 120),
  url: i.url,
  state: i.state?.name ?? "",
  description: clip(tidy(i.description ?? ""), 280),
});

export async function linearIssues(q?: string, limit = 25): Promise<SourceResult<LinearIssue>> {
  if (!secret("LINEAR_API_KEY")) return { items: [], connected: false, error: "LINEAR_API_KEY not in .env" };
  try {
    const text = q?.trim();
    if (text) {
      const d = await gql<{ searchIssues: { nodes: RawIssue[] } }>(
        `query($q: String!, $n: Int!) { searchIssues(term: $q, first: $n) { nodes { ${ISSUE} } } }`,
        { q: text, n: limit },
      );
      return { items: d.searchIssues.nodes.map(toIssue), connected: true, via: "search" };
    }
    const d = await gql<{ viewer: { assignedIssues: { nodes: RawIssue[] } } }>(
      `query($n: Int!) { viewer { assignedIssues(first: $n, orderBy: updatedAt,
        filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${ISSUE} } } } }`,
      { n: limit },
    );
    if (d.viewer.assignedIssues.nodes.length)
      return { items: d.viewer.assignedIssues.nodes.map(toIssue), connected: true, via: "assigned" };
    // nothing assigned → recent open issues across the workspace
    const r = await gql<{ issues: { nodes: RawIssue[] } }>(
      `query($n: Int!) { issues(first: $n, orderBy: updatedAt,
        filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${ISSUE} } } }`,
      { n: limit },
    );
    return { items: r.issues.nodes.map(toIssue), connected: true, via: "recent" };
  } catch (e) {
    return { items: [], connected: true, error: clip((e as Error).message, 140) };
  }
}
