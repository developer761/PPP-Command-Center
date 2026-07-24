/** Skeleton for an account (GC) detail page — header + tab bar + tab body.
 *  Without this the account detail inherited the dashboard-shaped skeleton
 *  and flashed a mismatched layout. */
export default function AccountDetailLoading() {
  return (
    <div className="space-y-4 animate-pulse" aria-hidden>
      <div className="h-3 w-48 bg-white border border-ppp-charcoal-100 rounded" />
      <div className="h-28 bg-white border border-ppp-charcoal-100 rounded-xl" />
      <div className="flex gap-2 border-b border-ppp-charcoal-100 pb-1 overflow-hidden">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-9 w-24 bg-white border border-ppp-charcoal-100 rounded" />
        ))}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 bg-white border border-ppp-charcoal-100 rounded-xl" />
        ))}
      </div>
      <div className="h-64 bg-white border border-ppp-charcoal-100 rounded-xl" />
    </div>
  );
}
