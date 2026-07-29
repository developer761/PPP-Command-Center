/** Skeleton for the Exclusions Library — header + add form + list. */
export default function ExclusionsLoading() {
  return (
    <div className="space-y-4 animate-pulse" aria-hidden>
      <div className="h-6 w-52 bg-surface border border-ppp-charcoal-100 rounded" />
      <div className="h-24 bg-surface border border-ppp-charcoal-100 rounded-xl" />
      <div className="bg-surface border border-ppp-charcoal-100 rounded-xl divide-y divide-ppp-charcoal-100 overflow-hidden">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-12" />
        ))}
      </div>
    </div>
  );
}
