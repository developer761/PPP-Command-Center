/** Skeleton for the cross-account Submittals index. */
export default function SubmittalsLoading() {
  return (
    <div className="space-y-5 animate-pulse" aria-hidden>
      <div className="h-8 w-40 bg-surface border border-ppp-charcoal-100 rounded" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 bg-surface border border-ppp-charcoal-100 rounded-xl" />
        ))}
      </div>
      <div className="h-11 bg-surface border border-ppp-charcoal-100 rounded-lg" />
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-20 bg-surface border border-ppp-charcoal-100 rounded-xl" />
      ))}
    </div>
  );
}
