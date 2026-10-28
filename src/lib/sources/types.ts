// Shared shapes for context sources. Client-safe (no server imports).

export type SourceResult<T> = { items: T[]; error?: string; connected: boolean; via?: string };

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  state: string;
  url: string;
  description: string; // <= 280 chars
}

export interface SlackMessage {
  id: string;
  text: string; // <= 280 chars
  channel: string;
  user?: string;
  permalink?: string;
  ts: string;
  bots?: number; // set when this row stands for N collapsed bot posts in the channel
}

export interface CliTool {
  name: string;
  installed: boolean;
  path?: string;
  version?: string;
}

export interface SessionMeta {
  id: string;
  project: string; // decoded cwd
  prompt: string; // first real user prompt, <= 120 chars
  modified: string;
  messages: number; // estimate
  bytes: number;
}

export interface SessionDigest {
  id: string;
  project: string;
  turns: { role: "user" | "assistant"; text: string }[];
  excerpt: string; // <= 400 chars, ready to attach as context
}

export const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
