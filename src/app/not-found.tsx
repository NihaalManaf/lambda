import Image from "next/image";
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col items-center px-6 py-24 text-center">
      <Image src="/art/muse-astro.webp" alt="" width={878} height={1325} loading="eager" className="fade-b h-60 w-auto" />
      <h1 className="display mt-8 text-6xl">
        lost in <span className="outlined italic">orbit</span>.
      </h1>
      <Link href="/" className="btn btn-primary mt-8">
        back home
      </Link>
    </main>
  );
}
