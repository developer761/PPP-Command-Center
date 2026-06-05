/**
 * Loading skeleton for /dashboard/materials. The shared dashboard loading.tsx
 * shows a KPI/chart layout that doesn't match the materials page's actual
 * shape (WO list + JobDetail right rail) — workers were seeing the wrong
 * skeleton and assuming the page broke. This skeleton mirrors the real
 * layout so the perceived load is shorter even when the SF snapshot is cold.
 */
export default function MaterialsLoading() {
  return (
    <div className="space-y-5 sm:space-y-6 animate-fade-up">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="h-7 w-56 bg-ppp-charcoal-100 rounded animate-pulse" />
          <div className="h-3.5 w-80 bg-ppp-charcoal-50 rounded animate-pulse" />
        </div>
        <div className="hidden sm:flex gap-2">
          <div className="h-8 w-28 bg-ppp-charcoal-100 rounded-lg animate-pulse" />
        </div>
      </div>

      {/* Stat strip — 4 chips */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 space-y-2"
          >
            <div className="h-3 w-20 bg-ppp-charcoal-50 rounded animate-pulse" />
            <div className="h-6 w-16 bg-ppp-charcoal-100 rounded animate-pulse" />
          </div>
        ))}
      </div>

      {/* Needs-attention banner */}
      <div className="h-14 bg-white border border-ppp-charcoal-100 rounded-xl animate-pulse" />

      {/* Main: WO list (2 col) + JobDetail (3 col) */}
      <section className="grid grid-cols-1 lg:grid-cols-5 gap-4 lg:gap-5">
        {/* WO list */}
        <div className="lg:col-span-2 bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          {/* Sticky header — sort + search */}
          <div className="px-5 py-3 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)] space-y-2.5">
            <div className="flex items-baseline justify-between">
              <div className="h-4 w-32 bg-ppp-charcoal-100 rounded animate-pulse" />
              <div className="h-3 w-8 bg-ppp-charcoal-50 rounded animate-pulse" />
            </div>
            <div className="h-3 w-40 bg-ppp-charcoal-50 rounded animate-pulse" />
            <div className="h-8 bg-white border border-ppp-charcoal-100 rounded-lg animate-pulse" />
          </div>
          {/* WO rows */}
          <ul className="divide-y divide-ppp-charcoal-100">
            {Array.from({ length: 6 }).map((_, i) => (
              <li key={i} className="px-5 py-3.5 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="h-4 w-40 bg-ppp-charcoal-100 rounded animate-pulse" />
                  <div className="h-4 w-12 bg-ppp-charcoal-50 rounded-full animate-pulse" />
                </div>
                <div className="h-3 w-3/4 bg-ppp-charcoal-50 rounded animate-pulse" />
              </li>
            ))}
          </ul>
        </div>

        {/* JobDetail right rail */}
        <div className="lg:col-span-3 space-y-4">
          <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6 space-y-4">
            <div className="space-y-2">
              <div className="h-3 w-24 bg-ppp-charcoal-50 rounded animate-pulse" />
              <div className="h-6 w-64 bg-ppp-charcoal-100 rounded animate-pulse" />
              <div className="h-3 w-40 bg-ppp-charcoal-50 rounded animate-pulse" />
            </div>
            {/* Progress bar */}
            <div className="h-12 bg-ppp-charcoal-50 rounded-lg animate-pulse" />
            {/* Paint estimate */}
            <div className="border border-ppp-charcoal-100 rounded-lg p-4 space-y-3">
              <div className="h-3 w-32 bg-ppp-charcoal-50 rounded animate-pulse" />
              <div className="h-8 w-48 bg-ppp-charcoal-100 rounded animate-pulse" />
            </div>
            {/* Supplier rows */}
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-12 bg-ppp-charcoal-50 rounded-lg animate-pulse" />
              ))}
            </div>
          </div>
        </div>
      </section>

      <p className="text-center text-xs text-ppp-charcoal-500 italic">
        Loading work orders from Salesforce… (first load can take 10–30s on a
        cold cache; subsequent loads use the 15-minute server-side cache.)
      </p>
    </div>
  );
}
