/** Skeleton for an account (GC) detail page — mirrors the current chrome:
 *  breadcrumb + header + 4-tab bar + Profitability block + body. Kept in sync
 *  with the live 4-leaf layout so the skeleton→content transition doesn't shift
 *  (R6 #6: the old skeleton showed 6 tabs + a phantom sub-pill row + a phantom
 *  Financial-snapshot card that no longer exist). */
export default function AccountDetailLoading() {
  return (
    <div className="space-y-4 animate-pulse" aria-hidden>
      <div className="h-3 w-48 bg-surface border border-ppp-charcoal-100 rounded" />
      <div className="h-28 bg-surface border border-ppp-charcoal-100 rounded-xl" />
      <div className="flex gap-2 border-b border-ppp-charcoal-100 pb-1 overflow-hidden">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-9 w-24 bg-surface border border-ppp-charcoal-100 rounded" />
        ))}
      </div>
      {/* Profitability block — Gross/Costs/Net/Margin tiles matching the real first section. */}
      <div className="border border-ppp-charcoal-100 rounded-xl p-4 bg-surface">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 bg-ppp-charcoal-50 rounded-lg" />
          ))}
        </div>
      </div>
      <div className="h-64 bg-surface border border-ppp-charcoal-100 rounded-xl" />
    </div>
  );
}
