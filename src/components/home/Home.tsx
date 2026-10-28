"use client";

import type { Feature } from "@/lib/types";
import { Hero } from "./Hero";
import { Composer } from "./Composer";
import { FeatureGrid } from "./FeatureGrid";
import { Manifesto } from "./Manifesto";

export function Home({ features }: { features: Feature[] }) {
  return (
    <main>
      <Hero />
      <div className="mx-auto max-w-3xl px-6">
        <Composer />
      </div>
      <FeatureGrid initial={features} />
      <Manifesto />
    </main>
  );
}
