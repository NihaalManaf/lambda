"use client";

import { Hero } from "./Hero";
import { Composer } from "./Composer";
import { Pipeline } from "./Pipeline";
import { Manifesto } from "./Manifesto";
import { Voices } from "./Voices";
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
      <Voices />
      <footer className="px-6 pb-16">
        <p className="text-center font-serif text-base italic text-ink-2">
          from those who care about where your attention lies.
        </p>
      </footer>
    </main>
  );
}
