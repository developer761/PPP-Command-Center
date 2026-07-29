/** Skeleton for the accounts (GC) list — header + KPI row + rows.
 *  The one major list page that was missing a loading state (2026-07-28). */
export default function AccountsLoading() {
  return (
    <div className="space-y-4 animate-pulse" aria-hidden>
      <div className="flex items-start justify-between gap-3">
        <div className="h-8 w-40 bg-surface border border-ppp-charcoal-100 rounded" />
        <div className="h-10 w-36 bg-surface border border-ppp-charcoal-100 rounded-lg" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 bg-surface border border-ppp-charcoal-100 rounded-xl" />
        ))}
      </div>
      <div className="h-10 bg-surface border border-ppp-charcoal-100 rounded-lg" />
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-16 bg-surface border border-ppp-charcoal-100 rounded-xl" />
      ))}
    </div>
  );
}
