// Workspace skeleton: title, brief, tab rail, tile row.
export default function Loading() {
  return (
    <div className="mx-auto max-w-7xl px-6 pt-10">
      <div className="shimmer h-3 w-20 rounded-full" />
      <div className="shimmer mt-4 h-14 w-2/3 rounded-2xl" />
      <div className="shimmer mt-4 h-4 w-1/2 rounded-full" />
      <div className="mt-10 flex gap-3 border-b border-line pb-3">
        {[64, 52, 72, 52, 64].map((w, i) => (
          <div key={i} className="shimmer h-5 rounded-full" style={{ width: w }} />
        ))}
      </div>
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="shimmer h-36 rounded-[18px]" />
        ))}
      </div>
    </div>
  );
}
