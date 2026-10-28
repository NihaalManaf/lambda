// Infra that is not code: CloudFormation SQS/ESM/EventBridge, the generated dependency map, GitHub cron workflows.
// Tiny indentation parser on purpose: CFN tags (!Ref, !GetAtt) break generic yaml loaders.
import path from "node:path";
import type { Hit } from "./scan";
import type { RawEsm, RawGhCron, RawQueue, RawRule, RawScan } from "./types";

interface Res { name: string; type: string; line: number; body: string[] }

function sections(lines: string[], header: string): { start: number; end: number } | null {
  const s = lines.findIndex((l) => l.trimEnd() === `${header}:`);
  if (s < 0) return null;
  let e = s + 1;
  while (e < lines.length && (!lines[e].trim() || /^\s/.test(lines[e]) || lines[e].trim().startsWith("#"))) e++;
  return { start: s + 1, end: e };
}

function blocks(lines: string[], header: string): Res[] {
  const sec = sections(lines, header);
  if (!sec) return [];
  const out: Res[] = [];
  for (let i = sec.start; i < sec.end; i++) {
    const m = /^ {2}(\w[\w-]*):\s*$/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < sec.end && (!lines[j].trim() || /^ {3,}/.test(lines[j]))) j++;
    const body = lines.slice(i + 1, j);
    out.push({ name: m[1], type: body.map((l) => /^\s+Type:\s*(\S+)/.exec(l)?.[1]).find(Boolean) ?? "", line: i + 1, body });
  }
  return out;
}

const prop = (r: Res, key: string) => r.body.map((l) => new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`).exec(l)?.[1]).find(Boolean);
const refName = (v?: string) => v && /!(?:Ref|GetAtt)\s+([\w-]+)/.exec(v)?.[1];
const unq = (v?: string) => v?.replace(/^['"]|['"]$/g, "");

// "cron(0 16 * * ? *)" -> "0 16 * * *"; "rate(5 minutes)" -> "*/5 * * * *"
export function awsCron(expr: string): string {
  const c = /cron\(([^)]+)\)/.exec(expr);
  if (c) return c[1].split(/\s+/).slice(0, 5).map((x) => (x === "?" ? "*" : x)).join(" ");
  const r = /rate\((\d+)\s+minute/.exec(expr);
  return r ? `*/${r[1]} * * * *` : expr;
}

export interface Infra { queues: RawQueue[]; esm: RawEsm[]; rules: RawRule[]; gh: RawGhCron[]; deps: RawScan["deps"]; queueEnv: RawScan["queueEnv"] }

export function infraFrom(hits: Hit[], allFiles: string[]): Infra {
  const out: Infra = { queues: [], esm: [], rules: [], gh: [], deps: [], queueEnv: [] };
  for (const h of hits) {
    if (!/\.ya?ml$/.test(h.file)) continue;
    const lines = h.text.split("\n");
    if (h.file.startsWith(".github/workflows/")) {
      lines.forEach((l, i) => {
        const m = /^\s*-\s*cron:\s*['"]?([^'"#]+?)['"]?\s*$/.exec(l);
        if (m) out.gh.push({ id: path.basename(h.file).replace(/\.ya?ml$/, ""), cron: m[1], file: h.file, line: i + 1 });
      });
      continue;
    }
    if (!/AWS::/.test(h.text)) continue;
    const params = new Map(blocks(lines, "Parameters").map((p) => [p.name, unq(prop(p, "Default"))]));
    const res = blocks(lines, "Resources");
    const by = new Map(res.map((r) => [r.name, r]));
    const qname = (r?: Res) => (r ? unq(prop(r, "QueueName")) ?? r.name : undefined);
    const dir = path.dirname(h.file);
    // handler "worker.lambda_handler" -> nearest worker.py under the template dir
    const handlerFile = (fnRes?: Res) => {
      const hd = unq(fnRes && prop(fnRes, "Handler"));
      if (!hd) return undefined;
      const [mod, fn] = [hd.slice(0, hd.lastIndexOf(".")), hd.slice(hd.lastIndexOf(".") + 1)];
      const want = `${mod.replace(/\./g, "/")}.py`;
      const file = allFiles.filter((f) => f.startsWith(`${dir}/`) && f.endsWith(`/${want}`)).sort((a, b) => a.length - b.length)[0];
      return file ? { file, fn } : undefined;
    };
    for (const r of res) {
      if (r.type === "AWS::SQS::Queue") {
        const dlq = qname(by.get(refName(r.body.find((l) => /deadLetterTargetArn/.test(l))) ?? ""));
        out.queues.push({ name: qname(r)!, ...(dlq ? { dlq } : {}), file: h.file, line: r.line });
      } else if (r.type === "AWS::Lambda::EventSourceMapping") {
        const q = by.get(refName(prop(r, "EventSourceArn")) ?? "");
        const hf = handlerFile(by.get(refName(prop(r, "FunctionName")) ?? ""));
        if (q?.type === "AWS::SQS::Queue" && hf) out.esm.push({ queue: qname(q)!, ...hf });
      } else if (r.type === "AWS::Events::Rule") {
        const se = prop(r, "ScheduleExpression") ?? "";
        const expr = refName(se) ? params.get(refName(se)!) ?? "" : unq(se) ?? "";
        const tgt = r.body.map((l) => /Arn:\s*(!GetAtt\s+[\w-]+)/.exec(l)?.[1]).find(Boolean);
        out.rules.push({ id: r.name, cron: awsCron(expr), file: h.file, line: r.line, target: handlerFile(by.get(refName(tgt) ?? "")) });
      } else if (r.type === "AWS::Lambda::Function") {
        const hf = handlerFile(r);
        for (const l of r.body) {
          const m = /^\s+(\w+):\s*(!(?:Ref|GetAtt)\s+[\w-]+)/.exec(l);
          const q = m && by.get(refName(m[2])!);
          if (m && hf && q?.type === "AWS::SQS::Queue") out.queueEnv.push({ dir: path.dirname(hf.file), env: m[1], queue: qname(q)! });
        }
      }
    }
  }
  return out;
}

// docs/generated/_dependencies.yaml: serviceCalls with method "sqs ..." + resources of type sqs.
export function depsFrom(text: string): { deps: RawScan["deps"]; queues: string[] } {
  const deps: RawScan["deps"] = [];
  const queues: string[] = [];
  let cur: Record<string, string> = {};
  const flush = () => {
    if (cur.caller && cur.callee && /^sqs\b/.test(cur.method ?? "")) deps.push({ caller: cur.caller.replace(/^webapp-/, ""), queue: cur.callee });
    cur = {};
  };
  let section = "";
  let lastName = "";
  for (const l of text.split("\n")) {
    const top = /^(\w+):/.exec(l);
    if (top) {
      flush();
      section = top[1];
      continue;
    }
    if (section === "serviceCalls") {
      const m = /^(-\s|\s\s)(\w+):\s*(.*)$/.exec(l);
      if (!m) continue;
      if (m[1] === "- ") flush();
      cur[m[2]] = m[3].trim();
    } else if (section === "resources") {
      const n = /^-?\s*name:\s*(\S+)/.exec(l);
      if (n) lastName = n[1];
      if (/^\s+type:\s*sqs\s*$/.test(l) && lastName) queues.push(lastName);
    }
  }
  flush();
  return { deps, queues };
}
