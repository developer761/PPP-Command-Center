/**
 * Skeleton loader row — used during data fetches on list surfaces.
 * Karan 2026-07-11 signature-moments Tier 3: replaces bare spinners
 * with content-shaped shimmer so users see the layout land before
 * the data does. Reduces perceived load time.
 *
 * Server component. Pure Tailwind + animate-pulse. Accepts a `rows`
 * count so a caller can render N ghost rows.
 */

export function SkeletonRow({ lines = 2 }: { lines?: number }) {
  return (
    <li className="px-4 py-4 border-b border-ppp-charcoal-100 last:border-b-0">
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-7 h-7 rounded-full bg-ppp-charcoal-100 animate-pulse" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="h-3.5 bg-ppp-charcoal-100 rounded animate-pulse w-3/5" />
          {Array.from({ length: Math.max(1, lines - 1) }).map((_, i) => (
            <div
              key={i}
              className="h-2.5 bg-ppp-charcoal-50 rounded animate-pulse"
              style={{ width: `${40 + (i * 15) % 40}%` }}
            />
          ))}
        </div>
        <div className="shrink-0 w-16 h-6 bg-ppp-charcoal-100 rounded animate-pulse" />
      </div>
    </li>
  );
}

export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <ul className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </ul>
  );
}
