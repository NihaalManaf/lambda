import { getHead } from "@/lib/schema/replay";
import SchemaExplorer from "@/components/schema/SchemaExplorer";
import SchemaWithAsk from "@/components/schema/SchemaWithAsk";
import { findPiece } from "@/lib/pieces";
import { getFeature } from "@/lib/store";

export const dynamic = "force-dynamic";
export const metadata = { title: "schema · lambda" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function SchemaPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  // opened from a feature: keep its ask bar here
  const fid = one(sp.feature);
  const feature = fid && /^[\w-]{1,64}$/.test(fid) ? getFeature(fid) : undefined;
  const piece = feature ? (findPiece(feature, one(sp.piece)) ?? feature.pieces[0]) : undefined;
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
        feature ? (
          <SchemaWithAsk head={head} initialTable={one(sp.table)} initialMigration={one(sp.m)} feature={feature} pieceId={piece?.id ?? ""} />
        ) : (
          <SchemaExplorer head={head} initialTable={one(sp.table)} initialMigration={one(sp.m)} />
        )
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
