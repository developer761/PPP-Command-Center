/**
 * Shared route-transition skeleton for Commercial pages that fetch on the server.
 * Rendered by per-segment loading.tsx files so a tab/nav switch shows immediate
 * feedback (skeleton-over-spinner) instead of a frozen previous page (audit R3
 * #10/#11/#25). `rows` tunes the number of list placeholder blocks.
 */
export default function PageSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-4 animate-pulse" aria-hidden>
      <div className="h-6 w-48 bg-surface border border-ppp-charcoal-100 rounded" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 bg-surface border border-ppp-charcoal-100 rounded-xl" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-14 bg-surface border border-ppp-charcoal-100 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
