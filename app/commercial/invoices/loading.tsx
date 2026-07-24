/** Skeleton for the invoices list (AR strip + KPI + rows). */
export default function InvoicesLoading() {
  return (
    <div className="space-y-4 animate-pulse" aria-hidden>
      <div className="flex items-start justify-between gap-3">
        <div className="h-6 w-32 bg-white border border-ppp-charcoal-100 rounded" />
        <div className="h-10 w-36 bg-white border border-ppp-charcoal-100 rounded-lg" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 bg-white border border-ppp-charcoal-100 rounded-xl" />
        ))}
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-16 bg-white border border-ppp-charcoal-100 rounded-xl" />
      ))}
    </div>
  );
}
