/** Skeleton for the pipeline (opportunities) list — heavy multi-query load. */
export default function OpportunitiesLoading() {
  return (
    <div className="space-y-4 animate-pulse" aria-hidden>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="h-6 w-40 bg-white border border-ppp-charcoal-100 rounded" />
          <div className="h-3 w-64 bg-white border border-ppp-charcoal-100 rounded" />
        </div>
        <div className="h-10 w-32 bg-white border border-ppp-charcoal-100 rounded-lg" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 bg-white border border-ppp-charcoal-100 rounded-xl" />
        ))}
      </div>
      <div className="h-10 bg-white border border-ppp-charcoal-100 rounded-lg" />
      <div className="flex gap-3 overflow-hidden">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex-1 min-w-[220px] h-72 bg-white border border-ppp-charcoal-100 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
