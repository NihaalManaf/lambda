// Route-level skeleton: keeps navigation instant while server data loads.
export default function Loading() {
  return (
    <div className="mx-auto max-w-7xl px-6 pt-16">
      <div className="shimmer h-4 w-40 rounded-full" />
      <div className="shimmer mt-6 h-20 w-3/4 rounded-2xl" />
      <div className="shimmer mt-3 h-20 w-1/2 rounded-2xl" />
      <div className="mt-16 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="shimmer h-48 rounded-[18px]" />
        ))}
      </div>
    </div>
  );
}
