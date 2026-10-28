"use client";

import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import type { Risk } from "@/lib/types";
import type { MigrationView } from "@/lib/schema/types";
import { DIFF } from "@/components/viz/diffStyle";
import { Icon } from "@/components/viz/icons";
import RiskList from "@/components/viz/RiskList";
import ShowSource from "@/components/viz/ShowSource";

// Right rail for one migration: title, date + file, what changed (icon rows grouped under their table), risks, </> at the bottom.

// long names lose their middle, never the end that tells them apart
export const mid = (s: string, n = 30) => (s.length <= n ? s : `${s.slice(0, Math.ceil((n - 1) / 2))}…${s.slice(s.length - Math.floor((n - 1) / 2))}`);

type Op = MigrationView["opsSummary"][number];
function groups(ops: Op[]) {
  const out: { table: string; rows: Op[] }[] = [];
  for (const o of ops) {
    const k = o.table ?? "";
    const g = out.find((x) => x.table === k) ?? (out.push({ table: k, rows: [] }), out[out.length - 1]);
    g.rows.push(o);
  }
  return out;
}

function OpRow({ o }: { o: Op }) {
  const look = DIFF[o.diff];
  // "− 17 columns" is a count: only a named removed item gets struck
  const m = /^([−+→] )(.*)$/.exec(o.text);
  const body = m ? m[2] : o.text;
  const strike = look.strike && !/^\d+ /.test(body);
  // "connection_request_note_mode default": the long name gives up its middle, the short tail stays whole
  const sp = body.indexOf(" ");
  const tail = sp > 0 && !/^\d+$/.test(body.slice(0, sp)) ? body.slice(sp) : "";
  const name = tail ? body.slice(0, sp) : body;
  return (
    <li className="flex items-center gap-2 text-[12.5px]">
      <span className="grid size-5 shrink-0 place-items-center rounded-md" style={{ background: look.bg, color: look.text }}>
        <Icon name={o.icon} size={12} />
      </span>
      <span className="min-w-0 truncate" title={o.text}>
        {m ? <span style={{ color: look.text }}>{m[1]}</span> : null}
        <span className={clsx(strike && "line-through decoration-bad/60")}>{mid(name, Math.max(12, 32 - tail.length))}</span>
        {tail}
      </span>
    </li>
  );
}

export default function MigrationRail({
  view,
  hover,
  onHover,
  onFocus,
  loadSql,
}: {
  view: MigrationView | null;
  hover: string | null;
  onHover: (id: string | null) => void;
  onFocus: (r: Risk) => void;
  loadSql: () => Promise<string>;
}) {
  if (!view)
    return (
      <div className="space-y-3 p-4">
        <div className="shimmer h-7 w-2/3 rounded-lg" />
        <div className="shimmer h-3 w-1/2 rounded-full" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="shimmer h-5 rounded-md" />
        ))}
      </div>
    );
  const { meta, opsSummary, graph } = view;
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={meta.id}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        className="flex h-full flex-col gap-4 p-4"
      >
        <div>
          <h2 className="display line-clamp-2 text-[24px] leading-[1.08]" title={meta.title}>{meta.title}</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-grey">
            <span>{meta.date}</span>
            {meta.dupPrefix && <span className="text-blue">twin</span>}
          </div>
          <div className="truncate font-mono text-[11px] text-grey" title={meta.file}>
            {meta.id}
          </div>
        </div>

        {opsSummary.length > 0 && (
          <div className="space-y-2.5">
            {groups(opsSummary).map((g) => (
              <div key={g.table}>
                {g.table && (
                  <div className="mb-1 truncate font-serif text-[14px] leading-tight text-ink" title={g.table}>
                    {mid(g.table, 34)}
                  </div>
                )}
                <ul className="space-y-1 border-l border-line-2 pl-2">
                  {g.rows.map((o, i) => (
                    <OpRow key={i} o={o} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        <div>
          <div className="eyebrow mb-1.5">risks</div>
          <RiskList risks={graph.risks} onFocus={onFocus} active={hover} onHover={onHover} />
        </div>

        <ShowSource load={loadSql} lang="sql" className="mt-auto" />
      </motion.div>
    </AnimatePresence>
  );
}
