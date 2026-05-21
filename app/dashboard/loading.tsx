/**
 * Loading skeleton for any /dashboard/* route during server-side data fetch.
 * At PPP scale (89k opps + 88k WOs) the first snapshot load can take 10-30
 * seconds. Without this, tabs feel "broken" because clicking them blocks
 * silently. With this, navigation feels instant and the user sees they
 * landed on the right page while data streams in.
 */
export default function DashboardLoading() {
  return (
    <div className="space-y-6 sm:space-y-8 animate-fade-up">
      {/* Header skeleton */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="h-7 w-48 bg-ppp-charcoal-100 rounded animate-pulse" />
          <div className="h-3.5 w-72 bg-ppp-charcoal-50 rounded mt-2 animate-pulse" />
        </div>
        <div className="flex gap-2">
          <div className="h-8 w-32 bg-ppp-charcoal-100 rounded-lg animate-pulse" />
          <div className="h-8 w-32 bg-ppp-charcoal-100 rounded-lg animate-pulse" />
        </div>
      </div>

      {/* KPI grid skeleton */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 space-y-3"
          >
            <div className="h-3 w-20 bg-ppp-charcoal-50 rounded animate-pulse" />
            <div className="h-8 w-24 bg-ppp-charcoal-100 rounded animate-pulse" />
            <div className="h-3 w-16 bg-ppp-charcoal-50 rounded animate-pulse" />
          </div>
        ))}
      </div>

      {/* Chart skeleton */}
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="h-5 w-40 bg-ppp-charcoal-100 rounded animate-pulse" />
            <div className="h-3 w-64 bg-ppp-charcoal-50 rounded mt-2 animate-pulse" />
          </div>
          <div className="h-8 w-24 bg-ppp-charcoal-100 rounded animate-pulse" />
        </div>
        <div className="mt-5 h-[200px] sm:h-[260px] bg-ppp-charcoal-50 rounded-lg animate-pulse" />
      </div>

      {/* Cards row skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6 space-y-4"
          >
            <div className="h-5 w-36 bg-ppp-charcoal-100 rounded animate-pulse" />
            <div className="h-3 w-full bg-ppp-charcoal-50 rounded animate-pulse" />
            <div className="space-y-2">
              {[0, 1, 2, 3].map((j) => (
                <div key={j} className="h-8 bg-ppp-charcoal-50 rounded animate-pulse" />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Leaderboard skeleton */}
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
        <div className="h-5 w-32 bg-ppp-charcoal-100 rounded animate-pulse" />
        <div className="mt-4 space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-12 bg-ppp-charcoal-50 rounded animate-pulse"
            />
          ))}
        </div>
      </div>

      <p className="text-center text-xs text-ppp-charcoal-500 italic">
        Loading PPP Salesforce data… (first load can take 10-30s at full
        production volume; subsequent loads use the 5-min cache)
      </p>
    </div>
  );
}
