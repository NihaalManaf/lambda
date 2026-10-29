"use client";

import { Hero } from "./Hero";
import { Composer } from "./Composer";
import { Pipeline } from "./Pipeline";
import { Manifesto } from "./Manifesto";
import { SetupBanner } from "@/components/setup/SetupBanner";

export function Home() {
  return (
    <main>
      <Hero />
      <div className="mx-auto max-w-3xl px-6">
        <SetupBanner />
        <Composer />
      </div>
      <Pipeline />
      <Manifesto />
    </main>
  );
}
