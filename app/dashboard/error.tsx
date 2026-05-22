"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Error boundary for the entire dashboard segment. Caught by Next when any
 * server or client render throws — typically a Salesforce outage, a malformed
 * snapshot, or a derive function crashing on an unexpected field shape.
 *
 * Keep the UI calm and branded: the worst-case is that an executive opens
 * the dashboard at 7am and the data layer is down. Don't show a stack trace.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to server for ops visibility — digest is correlated with Vercel logs.
    console.error("[dashboard] render error", { digest: error.digest, message: error.message });
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white border border-ppp-charcoal-100 rounded-2xl shadow-lg p-8 text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-ppp-orange-50 border border-ppp-orange-100 flex items-center justify-center mb-4">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ppp-orange-700" aria-hidden>
            <path d="M12 9v4 M12 17h.01 M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          </svg>
        </div>
        <h1 className="font-condensed text-xl font-bold text-ppp-navy uppercase tracking-tight">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm text-ppp-charcoal-600">
          We couldn&apos;t load this view. Salesforce may be temporarily unreachable,
          or a record may be in an unexpected state.
        </p>
        {error.digest && (
          <p className="mt-3 text-[11px] text-ppp-charcoal-500 font-mono">
            Ref: {error.digest}
          </p>
        )}
        <div className="mt-6 flex flex-col sm:flex-row gap-3 sm:gap-2 justify-center">
          <button
            type="button"
            onClick={() => reset()}
            className="min-h-[44px] px-5 py-2.5 rounded-lg bg-ppp-blue text-white text-sm font-medium hover:bg-ppp-blue-600 transition-colors"
          >
            Try again
          </button>
          <Link
            href="/dashboard"
            className="min-h-[44px] inline-flex items-center justify-center px-5 py-2.5 rounded-lg border border-ppp-charcoal-100 text-sm font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 transition-colors"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
