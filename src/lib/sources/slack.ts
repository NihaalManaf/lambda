import "server-only";
import { secret } from "../env";
import { clip, type SlackMessage, type SourceResult } from "./types";

// Slack Web API. search.messages needs a user token (xoxp, SLACK_TOKEN); otherwise
// fall back to the bot's channels + recent history, filtered client-side.

type Api = { ok: boolean; error?: string } & Record<string, unknown>;

async function call(method: string, token: string, params: Record<string, string | number> = {}): Promise<Api> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`https://slack.com/api/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({ ok: false, error: `http ${res.status}` }))) as Api;
  if (!json.ok) throw new Error(`${method}: ${json.error ?? "failed"}`);
  return json;
}

// Slack markup → plain text: <@U1>, <#C1|name>, <url|label>, *bold* _it_ ~st~ `code`, :emoji:, bare urls
const plain = (t: string) =>
  t
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<https?:[^>]+>/g, "")
    .replace(/<[@#!]?[^|>]+\|([^>]+)>/g, "$1")
    .replace(/<[@#!]?([^>]+)>/g, "@$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/(^|[\s(])[*_~`]+([^*_~`\n]+)[*_~`]+(?=[\s:.,)!?]|$)/g, "$1$2")
    .replace(/:[a-z0-9_+-]+:/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

type RawMatch = {
  iid?: string;
  ts: string;
  text: string;
  user?: string;
  username?: string;
  bot_id?: string;
  subtype?: string;
  permalink?: string;
  channel?: { id: string; name?: string };
};
const isBot = (m: RawMatch) => !!m.bot_id || m.subtype === "bot_message";

async function search(token: string, q: string, limit: number): Promise<SlackMessage[]> {
  const r = await call("search.messages", token, { query: q, count: limit, sort: "timestamp" });
  const matches = ((r.messages as { matches?: RawMatch[] })?.matches ?? []) as RawMatch[];
  return matches.map((m) => ({
    id: `${m.channel?.id ?? ""}:${m.ts}`,
    ts: m.ts,
    text: clip(plain(m.text ?? ""), 280),
    channel: m.channel?.name ? `#${m.channel.name}` : (m.channel?.id ?? ""),
    user: m.username ?? m.user,
    permalink: m.permalink,
  }));
}

type Chan = { id: string; name: string; is_member?: boolean };
let chanCache: { at: number; team: string; chans: Chan[] } | null = null;

async function botChannels(token: string) {
  if (chanCache && Date.now() - chanCache.at < 60_000) return chanCache;
  const auth = await call("auth.test", token);
  const r = await call("conversations.list", token, {
    types: "public_channel,private_channel",
    exclude_archived: "true",
    limit: 200,
  });
  const chans = ((r.channels as Chan[]) ?? []).filter((c) => c.is_member);
  chanCache = { at: Date.now(), team: String(auth.url ?? ""), chans };
  return chanCache;
}

async function history(token: string, q: string, limit: number): Promise<SlackMessage[]> {
  const { team, chans } = await botChannels(token);
  const needle = q.toLowerCase();
  const per = await Promise.all(
    chans.slice(0, 12).map(async (c) => {
      try {
        const r = await call("conversations.history", token, { channel: c.id, limit: 60 });
        const msgs = ((r.messages as RawMatch[]) ?? []).filter(
          (m) => m.text && plain(m.text) && (!needle || m.text.toLowerCase().includes(needle)),
        );
        const row = (m: RawMatch, bots?: number): SlackMessage => ({
          id: `${c.id}:${m.ts}`,
          ts: m.ts,
          text: clip(plain(m.text), 280),
          channel: `#${c.name}`,
          user: m.user,
          permalink: team ? `${team}archives/${c.id}/p${m.ts.replace(".", "")}` : undefined,
          ...(bots ? { bots } : {}),
        });
        // people first; a channel's bot dumps collapse to one row (latest)
        const bots = msgs.filter(isBot);
        return [...msgs.filter((m) => !isBot(m)).map((m) => row(m)), ...(bots.length ? [row(bots[0], bots.length)] : [])];
      } catch {
        return [];
      }
    }),
  );
  return per
    .flat()
    .sort((a, b) => Number(!!a.bots) - Number(!!b.bots) || Number(b.ts) - Number(a.ts))
    .slice(0, limit);
}

export async function slackMessages(q?: string, limit = 25): Promise<SourceResult<SlackMessage>> {
  const user = secret("SLACK_TOKEN");
  const bot = secret("SLACK_BOT_TOKEN") ?? user;
  if (!bot) return { items: [], connected: false, error: "SLACK_BOT_TOKEN not in .env" };
  const text = q?.trim() ?? "";
  // user token + query → real search; any failure falls through to history scan
  if (user && text) {
    try {
      return { items: await search(user, text, limit), connected: true, via: "search" };
    } catch {
      /* not a user token or missing search:read scope */
    }
  }
  try {
    return { items: await history(bot, text, limit), connected: true, via: "channels" };
  } catch (e) {
    return { items: [], connected: true, error: clip((e as Error).message, 140) };
  }
}
