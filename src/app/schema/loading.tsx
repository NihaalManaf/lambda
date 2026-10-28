// Schema skeleton: title, scrubber strip, canvas + rail.
export default function Loading() {
  return (
    <div className="mx-auto max-w-7xl px-4 pt-8 md:px-6 md:pt-10">
      <div className="shimmer h-3 w-40 rounded-full" />
      <div className="shimmer mt-4 h-14 w-56 rounded-2xl" />
      <div className="shimmer mt-6 h-20 rounded-[18px]" />
      <div className="mt-4 flex gap-4">
        <div className="shimmer h-[580px] flex-1 rounded-[18px]" />
        <div className="shimmer hidden h-[580px] w-[280px] rounded-[18px] md:block" />
      </div>
    </div>
  );
}
