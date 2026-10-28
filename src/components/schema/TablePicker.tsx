"use client";

import { useMemo } from "react";
import { motion } from "motion/react";
import clsx from "clsx";
import type { SchemaHead } from "@/lib/schema/types";
import { Icon } from "@/components/viz/icons";

// Head mode: every table as a tile, grouped by name prefix. Bigger tile = more columns; dashed = partial (stub).

type T = SchemaHead["tables"][number];

export default function TablePicker({
  tables,
  filter,
  onPick,
}: {
  tables: SchemaHead["tables"];
  filter: string;
  onPick: (id: string) => void;
}) {
  const q = filter.trim().toLowerCase();
  const groups = useMemo(() => {
    const m = new Map<string, T[]>();
    for (const t of tables) if (!q || t.label.includes(q)) m.set(t.group, [...(m.get(t.group) ?? []), t]);
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [tables, q]);

  if (!groups.length) return <div className="grid h-64 place-items-center font-hand text-lg text-grey">no match</div>;

  return (
    <div className="columns-1 gap-4 p-4 sm:columns-2 xl:columns-3">
      {groups.map(([g, ts], gi) => (
        <motion.section
          key={g}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, delay: Math.min(gi, 12) * 0.02, ease: [0.22, 1, 0.36, 1] }}
          className="mb-4 break-inside-avoid"
        >
          <div className="mb-1.5 flex items-baseline gap-2">
            <span className="font-serif text-[17px]">{g}</span>
            <span className="font-mono text-[10px] text-grey">{ts.length}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ts.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onPick(t.id)}
                title={`${t.label} · ${t.cols} cols`}
                style={{ minWidth: 56 + Math.min(t.cols, 40) * 3.2, height: 30 + Math.min(t.cols, 40) * 0.5 }}
                className={clsx(
                  "group flex items-center gap-1.5 rounded-xl border-[1.5px] bg-card px-2.5 text-left transition-[transform,border-color,box-shadow] duration-150 hover:-translate-y-px hover:border-ink hover:shadow-[2px_3px_0_var(--line-2)] active:scale-[0.97]",
                  t.origin === "stub" ? "border-dashed border-line-2 text-ink-2" : "border-line",
                )}
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">
                  {t.label.startsWith(`${g}_`) ? t.label.slice(g.length + 1) : t.label}
                </span>
                <span className="font-mono text-[10px] text-grey">{t.cols}</span>
                {t.fks > 0 && (
                  <span className="flex items-center gap-px font-mono text-[10px] text-grey">
                    <Icon name="link" size={10} />
                    {t.fks}
                  </span>
                )}
              </button>
            ))}
          </div>
        </motion.section>
      ))}
    </div>
  );
}
