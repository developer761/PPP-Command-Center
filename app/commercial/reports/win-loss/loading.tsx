/** Skeleton for the win/loss report (KPI row + breakdown cards). */
export default function WinLossLoading() {
  return (
    <div className="space-y-4 animate-pulse" aria-hidden>
      <div className="h-6 w-40 bg-white border border-ppp-charcoal-100 rounded" />
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-20 bg-white border border-ppp-charcoal-100 rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="h-64 bg-white border border-ppp-charcoal-100 rounded-xl" />
        <div className="h-64 bg-white border border-ppp-charcoal-100 rounded-xl" />
      </div>
    </div>
  );
}
