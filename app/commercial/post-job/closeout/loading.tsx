/** Skeleton for the cross-project Closeout & Warranty index. */
export default function CloseoutLoading() {
  return (
    <div className="space-y-5 animate-pulse" aria-hidden>
      <div className="h-8 w-52 bg-surface border border-ppp-charcoal-100 rounded" />
      <div className="grid grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-20 bg-surface border border-ppp-charcoal-100 rounded-xl" />
        ))}
      </div>
      <div className="h-11 bg-surface border border-ppp-charcoal-100 rounded-lg" />
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-20 bg-surface border border-ppp-charcoal-100 rounded-xl" />
      ))}
    </div>
  );
}
