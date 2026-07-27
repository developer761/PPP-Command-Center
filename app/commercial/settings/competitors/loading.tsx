/** Skeleton for Settings → Competitors — header + add form + list. */
export default function CompetitorsLoading() {
  return (
    <div className="space-y-4 animate-pulse" aria-hidden>
      <div className="h-6 w-48 bg-white border border-ppp-charcoal-100 rounded" />
      <div className="h-24 bg-white border border-ppp-charcoal-100 rounded-xl" />
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl divide-y divide-ppp-charcoal-100 overflow-hidden">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-14" />
        ))}
      </div>
    </div>
  );
}
