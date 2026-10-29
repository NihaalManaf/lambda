import "server-only";
import { isIntakeLive } from "./intake";
import { isActive } from "./jobs";
import { allRuns } from "./pieces";
import type { Feature } from "./types";

// What, if anything, an agent is doing on a feature right now — for the features list.
// Live process state lives in this server's memory, so it's computed here and sent with the list.
export type Listed = Feature & { busy: string | null };

export function busyLabel(f: Feature): string | null {
  if (isIntakeLive(f.id)) return "thinking";
  if (isIntakeLive(`${f.id}:code`)) return "reading the code";
  const job = [...(f.jobs ?? []), ...(f.pieces ?? []).flatMap((p) => p.jobs ?? [])].find(isActive);
  if (job) return job.kind === "sketch" ? "sketching" : job.kind === "facts" ? "reading the code" : job.kind === "check" ? "checking against the code" : `writing ${job.kind}`;
  if (allRuns(f).some((r) => r.status === "queued" || r.status === "running")) return "verifying";
  return null;
}

export const withBusy = (fs: Feature[]): Listed[] => fs.map((f) => ({ ...f, busy: busyLabel(f) }));
