import { withBusy } from "@/lib/busy";
import { listFeatures } from "@/lib/store";
import { FeatureGrid } from "@/components/home/FeatureGrid";

export const dynamic = "force-dynamic";
export const metadata = { title: "features · lambda" };

export default function FeaturesPage() {
  return (
    <main>
      <FeatureGrid initial={withBusy(listFeatures())} />
    </main>
  );
}
