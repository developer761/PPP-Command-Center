/**
 * Shown when a page is requested with no connection and nothing cached.
 *
 * Deliberately tells the crew what still works rather than only what doesn't —
 * the measurement maths is entirely client-side, so a room already open can be
 * finished in a basement with no bars.
 */
export default function OfflinePage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-[var(--color-surface-muted)]">
      <div className="max-w-sm text-center">
        <div className="text-4xl mb-3" aria-hidden>📶</div>
        <h1 className="font-condensed text-xl font-bold text-ppp-navy">No signal here</h1>
        <p className="text-sm text-ppp-charcoal-600 mt-2 leading-relaxed">
          The Command Center needs a connection to load work orders and colours.
        </p>
        <div className="mt-5 text-left bg-white border border-ppp-charcoal-100 rounded-xl p-4">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-ppp-charcoal-500 mb-2">
            Still works offline
          </div>
          <ul className="text-[13px] text-ppp-charcoal-700 space-y-1.5 leading-snug">
            <li>· Measuring a room you already have open</li>
            <li>· Walking the walls and reading the floor plan</li>
            <li>· Taking photos to measure once you&rsquo;re back in range</li>
          </ul>
        </div>
        <p className="text-[11px] text-ppp-charcoal-500 mt-4">
          Anything you save will need signal — step outside and try again.
        </p>
      </div>
    </div>
  );
}
