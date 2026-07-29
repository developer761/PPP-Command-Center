/** Skeleton for Settings → Archived deals — header + table/cards. */
export default function ArchivedLoading() {
  return (
    <div className="space-y-4 animate-pulse" aria-hidden>
      <div className="h-6 w-52 bg-surface border border-ppp-charcoal-100 rounded" />
      <div className="h-4 w-80 max-w-full bg-surface border border-ppp-charcoal-100 rounded" />
      <div className="bg-surface border border-ppp-charcoal-100 rounded-xl divide-y divide-ppp-charcoal-100 overflow-hidden">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-14" />
        ))}
      </div>
    </div>
  );
}
