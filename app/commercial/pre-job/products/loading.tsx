/** Skeleton for the Product Library list — header + filter row + rows. */
export default function ProductsLoading() {
  return (
    <div className="space-y-4 animate-pulse" aria-hidden>
      <div className="h-6 w-56 bg-white border border-ppp-charcoal-100 rounded" />
      <div className="flex gap-2">
        <div className="h-10 flex-1 bg-white border border-ppp-charcoal-100 rounded-lg" />
        <div className="h-10 w-28 bg-white border border-ppp-charcoal-100 rounded-lg" />
      </div>
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl divide-y divide-ppp-charcoal-100 overflow-hidden">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-14" />
        ))}
      </div>
    </div>
  );
}
