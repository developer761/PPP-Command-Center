import Link from "next/link";

/**
 * What a Commercial link shows when the thing behind it is gone.
 *
 * There wasn't one. `notFound()` is called correctly in a dozen places — a
 * proposal id that doesn't exist, a deal whose account has been deleted — and
 * every one of them fell through to a page carrying the sidebar and nothing
 * else: no message, no explanation, no way back. On live data that is 38 of the
 * 57 proposals on this platform, because deleting a GC leaves its jobs behind
 * and every proposal under them becomes unreachable this way.
 *
 * A dead end is not the problem; an UNEXPLAINED dead end is. Someone following
 * a link out of an email needs to know the record is gone rather than wonder
 * whether the page is broken.
 */
export default function CommercialNotFound() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-surface border border-ppp-charcoal-100 rounded-2xl shadow-sm p-8 text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-ppp-charcoal-50 border border-ppp-charcoal-100 flex items-center justify-center mb-4">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ppp-charcoal-400" aria-hidden>
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35 M11 8v3 M11 14h.01" />
          </svg>
        </div>
        <h1 className="text-lg font-bold text-ppp-charcoal">
          That record isn&rsquo;t here
        </h1>
        <p className="mt-2 text-[13px] text-ppp-charcoal-600 leading-relaxed">
          The job, proposal or account behind this link has been deleted, or the
          address is wrong. Nothing is broken &mdash; there is just nothing at
          this address any more.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Link
            href="/commercial/opportunities"
            className="inline-flex items-center px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[44px]"
          >
            Go to opportunities
          </Link>
          <Link
            href="/commercial"
            className="inline-flex items-center px-4 py-2 rounded-lg border border-ppp-charcoal-200 bg-surface text-ppp-charcoal-700 text-[13px] font-semibold hover:bg-ppp-charcoal-50 min-h-[44px]"
          >
            Overview
          </Link>
        </div>
      </div>
    </div>
  );
}
