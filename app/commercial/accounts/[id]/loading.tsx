/** Skeleton for an account (GC) detail page — header + tab bar + tab body.
 *  Without this the account detail inherited the dashboard-shaped skeleton
 *  and flashed a mismatched layout. */
export default function AccountDetailLoading() {
  return (
    <div className="space-y-4 animate-pulse" aria-hidden>
      <div className="h-3 w-48 bg-white border border-ppp-charcoal-100 rounded" />
      <div className="h-28 bg-white border border-ppp-charcoal-100 rounded-xl" />
      <div className="flex gap-2 border-b border-ppp-charcoal-100 pb-1 overflow-hidden">
        {/* 6 primary tabs (Overview/Opportunities/Proposals/Invoices/People/
            Activity) so the skeleton→content transition doesn't shift. */}
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-9 w-24 bg-white border border-ppp-charcoal-100 rounded" />
        ))}
      </div>
      {/* Sub-tab pill row (Overview/People/Deals show one). */}
      <div className="flex gap-2 overflow-hidden">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-9 w-20 bg-white border border-ppp-charcoal-100 rounded-full" />
        ))}
      </div>
      {/* Financial snapshot: 3-tile card matching the real first block. */}
      <div className="border border-ppp-charcoal-100 rounded-xl p-4 bg-white">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-20 bg-ppp-charcoal-50 rounded-lg" />
          ))}
        </div>
      </div>
      <div className="h-64 bg-white border border-ppp-charcoal-100 rounded-xl" />
    </div>
  );
}
