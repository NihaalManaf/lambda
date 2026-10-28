import Image from "next/image";
import SourcesBoard from "@/components/sources/SourcesBoard";

export const metadata = { title: "sources · lambda" };

export default function SourcesPage() {
  return (
    <main className="mx-auto max-w-7xl px-6 pb-24 pt-10">
      <div className="relative mb-10 flex items-end justify-between gap-6">
        <div>
          <div className="eyebrow mb-3">context · pulled from your tools</div>
          <h1 className="display text-6xl md:text-7xl">
            sources<span className="outlined">.</span>
          </h1>
          <p className="mt-4 max-w-md text-[15px] text-ink-2">what the agents already know. attach any of it to a feature.</p>
        </div>
        <Image
          src="/art/scribe-stylus.webp"
          alt=""
          width={900}
          height={1281}
          priority
          className="fade-b pointer-events-none hidden h-48 w-auto select-none object-contain md:block"
        />
      </div>
      <SourcesBoard />
    </main>
  );
}
