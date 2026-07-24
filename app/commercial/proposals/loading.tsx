/**
 * Skeleton for the Proposals surface (skeleton-over-spinner rule). This page
 * awaits list fetches AND runs reconcileDealStatesFromProposals() on load, so
 * it can take a beat — show structure instead of a blank flash.
 */
export default function ProposalsLoading() {
  return (
    <div className="space-y-4 animate-pulse" aria-hidden>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="h-6 w-40 bg-white border border-ppp-charcoal-100 rounded" />
          <div className="h-3 w-72 bg-white border border-ppp-charcoal-100 rounded" />
        </div>
        <div className="h-10 w-36 bg-white border border-ppp-charcoal-100 rounded-lg" />
      </div>
      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 bg-white border border-ppp-charcoal-100 rounded-xl" />
        ))}
      </div>
      {/* Deal group cards */}
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-40 bg-white border border-ppp-charcoal-100 rounded-xl" />
      ))}
    </div>
  );
}
