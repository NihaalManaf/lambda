// Domains: ordered path/module rules (the queue scout's 12 domains), first match wins, leftovers -> misc.
// Producers and consumers that miss every rule inherit the domain of the channel they touch.
import type { Domain } from "./types";
import type { Linked } from "./link";

export const DOMAINS: { id: string; label: string; rx: RegExp }[] = [
  { id: "sms", label: "sms", rx: /sendblue|\bsms\b/i },
  { id: "linkedin", label: "linkedin", rx: /linkedin/i },
  { id: "magicpitch", label: "magicpitch", rx: /magicpitch|sender[-_]pool|topup/i },
  { id: "matching", label: "matching", rx: /^\/match\/|\/match\/|auto[-_]matching|semantic_match|targeting/i },
  { id: "demos", label: "demos", rx: /demo[-_]?(booking|lead)|noshow|no[-_]show|calendly|meta[-_]demo|sales[-_]demo|demo/i },
  { id: "reply", label: "replies + inbox", rx: /\/track\/|\/v1\/mail\/|\/v1\/inbox|reply[-_]|notification|gmail|outlook|nylas|watch|inbox|tracking/i },
  { id: "drafts", label: "drafts", rx: /\/v1\/draft|\/rewrite|ai-rewrite|\/v1\/template|regenerat|email_generation|email_rewrite|draft/i },
  { id: "sending", label: "sending", rx: /\/schedule|wrap-send|scheduler_dispatch|resume-|stalled-|rate-limited|emails-sent|email_sending|send/i },
  { id: "workflows", label: "workflows", rx: /\/v1\/workflow|workflow|alert/i },
  { id: "onboarding", label: "onboarding", rx: /onboarding|trial|reward|cashback|referral|teammate|invite|pay[-_]your[-_]way/i },
  { id: "crm", label: "crm sync", rx: /hubspot|klaviyo|baremetrics|crisp|google[-_]ads|analytics|refresh|weekly|recap|csm|kpi|materialized/i },
  { id: "enrichment", label: "enrichment", rx: /integration|enrich|profile[-_]enhance|guest[-_]podcast/i },
];
export const MISC = { id: "misc", label: "misc" };

export const domainOf = (subject: string) => DOMAINS.find((d) => d.rx.test(subject))?.id ?? MISC.id;

export function cluster(t: Pick<Linked, "producers" | "channels" | "consumers" | "edges">): Domain[] {
  const of = new Map<string, string>();
  // channels first: their key is the most specific signal (path / queue / schedule id)
  for (const c of t.channels) of.set(c.id, domainOf(c.key));
  for (const k of t.consumers) of.set(k.id, domainOf(`${k.route ?? ""} ${k.file} ${k.symbol}`));
  for (const p of t.producers) of.set(p.id, domainOf(`${p.trigger?.kind === "cron" ? p.trigger.scheduleId : p.trigger?.kind === "http" ? p.trigger.route : ""} ${p.file} ${p.symbol}`));
  // misc nodes inherit from neighbours (schedules from their handler, handlers from their channel)
  for (let pass = 0; pass < 3; pass++) {
    for (const e of t.edges) {
      const a = of.get(e.from);
      const b = of.get(e.to);
      if (a === MISC.id && b && b !== MISC.id) of.set(e.from, b);
      else if (b === MISC.id && a && a !== MISC.id) of.set(e.to, a);
    }
  }
  const out = new Map<string, Domain>();
  for (const [nid, d] of of) {
    const meta = DOMAINS.find((x) => x.id === d) ?? MISC;
    const dom = out.get(d) ?? { id: d, label: meta.label, nodeIds: [] };
    dom.nodeIds.push(nid);
    out.set(d, dom);
  }
  const order = [...DOMAINS.map((d) => d.id), MISC.id];
  return [...out.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}
