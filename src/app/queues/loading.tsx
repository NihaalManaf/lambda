// Route skeleton: scan bar, canvas, rail.
export default function Loading() {
  return (
    <div className="mx-auto max-w-7xl px-4 pt-10 md:px-6">
      <div className="shimmer h-4 w-36 rounded-full" />
      <div className="shimmer mt-4 h-16 w-64 rounded-2xl" />
      <div className="shimmer mt-8 h-11 rounded-full" />
      <div className="mt-6 grid gap-4 md:grid-cols-[minmax(0,1fr)_280px]">
        <div className="shimmer h-[420px] rounded-[18px]" />
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="shimmer h-6 rounded-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
