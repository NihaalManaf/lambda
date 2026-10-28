// URL expression (rendered by the extractor: literal text + {placeholders}) -> channel key.
// "{env:API_URL}/match/itunes" -> /match/itunes; "https://api-staging.x.com/a" -> /a @ api-staging.x.com.

export interface Target { path: string; host?: string; staging: boolean; resolved: boolean; external: boolean }

const BASE_HOSTS = ["localhost", "127\\.0\\.0\\.1", "\\{env:(API_URL|CRON_TARGET_API_URL|NEXT_PUBLIC_SITE_URL|SITE_URL|BASE_URL)\\}"];
let OUR_HOST = new RegExp(BASE_HOSTS.join("|"), "i");

// settings.appHosts: host fragments of the app's own API ("myapp" matches api.myapp.com, api-staging.myapp.com)
export function setAppHosts(hosts: string[]) {
  const esc = hosts.filter(Boolean).map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  OUR_HOST = new RegExp([...BASE_HOSTS, ...esc].join("|"), "i");
}

export function resolveUrl(expr: unknown): Target {
  const s = typeof expr === "string" ? expr.trim() : "";
  if (!s) return { path: "?", staging: false, resolved: false, external: false };
  let host: string | undefined;
  let rest = s;
  const abs = /^https?:\/\/([^/{}]+)(.*)$/.exec(s);
  if (abs) {
    host = abs[1];
    rest = abs[2] || "/";
  } else {
    // leading placeholder(s) = host part: {env:API_URL}, {api_url}, {base}
    const lead = /^((?:\{[^{}]*\})+)(.*)$/.exec(s);
    if (lead) {
      host = lead[1].replace(/^\{(?:env:)?|\}$/g, "");
      rest = lead[2];
    }
  }
  const path = rest.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  const resolved = path.startsWith("/") && path.replace(/\{[^}]*\}/g, "").replace(/\//g, "").length > 0;
  const external = !!host && !!abs && !OUR_HOST.test(host);
  return { path: resolved ? path.replace(/\{[^}]*\}/g, "{}") : "?", host, staging: /staging/i.test(host ?? ""), resolved, external };
}

// SQS queue name from a QueueUrl expression, env names it reads, and the known queue list.
const GENERIC = new Set(["sqs", "queue", "url", "env", "aws", "the", "q"]);
const toks = (s: string) =>
  s.toLowerCase().replace(/([a-z])([A-Z])/g, "$1_$2").split(/[^a-z0-9]+/).filter((t) => t && !GENERIC.has(t)).map((t) => t.replace(/s$/, ""));

export function matchQueue(hints: string[], known: string[]): string | null {
  for (const h of hints) {
    const url = /sqs\.[^/]+\/\d+\/([\w-]+)/.exec(h);
    if (url) return url[1];
  }
  // full overlap one way or the other; ambiguous ties resolve to nothing
  const scored = new Map<string, number>();
  for (const q of known) {
    const qt = toks(q);
    for (const h of hints) {
      const ht = new Set(toks(h));
      const score = qt.filter((t) => ht.has(t)).length;
      if (score && (score === qt.length || score === ht.size)) scored.set(q, Math.max(scored.get(q) ?? 0, score));
    }
  }
  const top = Math.max(0, ...scored.values());
  const best = [...scored].filter(([, s]) => s === top);
  return best.length === 1 ? best[0][0] : null;
}

// queue name -> lambda dir name: "reply-tracking" ~ "reply_tracking", "outlook-notifications" ~ "outlook_notification"
export const sameName = (queue: string, dir: string) => toks(queue).join("_") === toks(dir).join("_");
