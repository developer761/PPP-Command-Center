/**
 * Skeleton for the Commercial dashboard (skeleton-over-spinner rule). The
 * page is an async server component that awaits 3 parallel queries; without
 * this the route flashed blank until the server resolved.
 */
export default function CommercialDashboardLoading() {
  return (
    <div className="space-y-4 sm:space-y-6 animate-pulse" aria-hidden>
      {/* Welcome strip */}
      <div className="h-14 bg-white border border-ppp-charcoal-100 rounded-xl" />
      {/* Hero */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2 h-28 bg-white border border-ppp-charcoal-100 rounded-xl" />
        <div className="h-28 bg-white border border-ppp-charcoal-100 rounded-xl" />
      </div>
      {/* Attention / KPI strips */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 bg-white border border-ppp-charcoal-100 rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 bg-white border border-ppp-charcoal-100 rounded-xl" />
        ))}
      </div>
      {/* Two-column */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="h-64 bg-white border border-ppp-charcoal-100 rounded-xl" />
        <div className="h-64 bg-white border border-ppp-charcoal-100 rounded-xl" />
      </div>
    </div>
  );
}
