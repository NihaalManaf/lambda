import { notFound } from "next/navigation";
import { getFeature } from "@/lib/store";
import Workspace from "@/components/Workspace";

export const dynamic = "force-dynamic";

export default async function FeaturePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const feature = getFeature(id);
  if (!feature) notFound();
  return <Workspace initial={feature} />;
}
