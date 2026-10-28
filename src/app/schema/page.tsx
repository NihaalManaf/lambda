import { getHead } from "@/lib/schema/replay";
import SchemaExplorer from "@/components/schema/SchemaExplorer";

export const dynamic = "force-dynamic";
export const metadata = { title: "schema · lambda" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function SchemaPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  let head: Awaited<ReturnType<typeof getHead>> | null = null;
  let error = "";
  try {
    head = await getHead();
  } catch (e) {
    error = e instanceof Error ? e.message : "replay failed";
  }

  return (
    <main className="mx-auto min-w-0 max-w-7xl px-4 pb-24 pt-8 md:px-6 md:pt-10">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-3">database</div>
          <h1 className="display text-5xl md:text-6xl">
            schema<span className="outlined">.</span>
          </h1>
        </div>
      </div>
      {head && head.migrations.length + head.tables.length > 0 ? (
        <SchemaExplorer head={head} initialTable={one(sp.table)} initialMigration={one(sp.m)} />
      ) : (
        <div className="card flex flex-col items-center py-16 text-center">
          <div className="display text-3xl">
            no migrations <span className="outlined">found</span>
          </div>
          <p className="mt-2 font-mono text-[12px] text-grey">{error || "check repo path in settings"}</p>
        </div>
      )}
    </main>
  );
}
