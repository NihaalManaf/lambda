import VA from "@/components/home/pipeline-lab/VA";
import VB from "@/components/home/pipeline-lab/VB";
import VC from "@/components/home/pipeline-lab/VC";
import { Pipeline } from "@/components/home/Pipeline";

export const dynamic = "force-dynamic";

// TEMP design lab for the home pipeline section — delete once a variant ships
export default async function Lab({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  const { v } = await searchParams;
  const V = { A: VA, B: VB, C: VC }[v ?? ""];
  return <main className="min-h-screen">{V ? <V count={7} /> : <Pipeline />}</main>;
}
