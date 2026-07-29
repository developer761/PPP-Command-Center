/** Skeleton for the Projects command center. */
export default function ProjectsLoading() {
  return (
    <div className="space-y-5 animate-pulse" aria-hidden>
      <div className="h-8 w-40 bg-white border border-ppp-charcoal-100 rounded" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 bg-white border border-ppp-charcoal-100 rounded-xl" />
        ))}
      </div>
      <div className="h-11 bg-white border border-ppp-charcoal-100 rounded-lg" />
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-32 bg-white border border-ppp-charcoal-100 rounded-xl" />
      ))}
    </div>
  );
}
