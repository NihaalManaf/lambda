import Image from "next/image";

export function EmptyState() {
  return (
    <div className="flex flex-col items-center py-16 text-center">
      <Image
        src="/art/youth-astro.webp"
        alt=""
        width={821}
        height={1281}
        className="fade-b h-48 w-auto opacity-90"
      />
      <p className="display mt-6 text-3xl">
        nothing <span className="italic">shaped</span> yet.
      </p>
      <p className="eyebrow mt-3">start with one feature above</p>
    </div>
  );
}
