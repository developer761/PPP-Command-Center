/** Skeleton for an opportunity detail page (header + tab bar + tab body). */
export default function OpportunityDetailLoading() {
  return (
    <div className="space-y-4 animate-pulse" aria-hidden>
      <div className="h-3 w-56 bg-white border border-ppp-charcoal-100 rounded" />
      <div className="h-24 bg-white border border-ppp-charcoal-100 rounded-xl" />
      <div className="flex gap-2 border-b border-ppp-charcoal-100 pb-1">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-8 w-24 bg-white border border-ppp-charcoal-100 rounded" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="h-56 bg-white border border-ppp-charcoal-100 rounded-xl" />
        <div className="h-56 bg-white border border-ppp-charcoal-100 rounded-xl" />
      </div>
    </div>
  );
}
