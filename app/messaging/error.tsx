"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Error boundary for the whole Messaging segment.
 *
 * Commercial and the residential dashboard have had one for a while; Messaging
 * never did. So anything that threw during a render — a Supabase hiccup, a
 * transcript in a shape nothing expected, a workspace with no timezone —
 * escaped to app/global-error.tsx, which supplies its own <html> and therefore
 * destroys the messaging chrome and the sidebar on the way out. The person
 * reading it got a bare "Application error", no branding, no way back, and
 * nothing to quote when they call Karan.
 *
 * WHY THIS MATTERS MORE HERE THAN ANYWHERE ELSE. Most of the loaders in this
 * area used to swallow their errors and return an empty list, so a failure
 * rendered as "Nothing waiting — every reply has been dealt with" on the queue
 * of customers waiting for a human to answer them. Those loaders now throw,
 * which is only an improvement if there is something to catch them. This is
 * that something: a visible failure instead of a confident, wrong emptiness.
 */
export default function MessagingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[messaging] render error", {
      digest: error.digest,
      message: error.message,
    });
  }, [error]);

  return (
    <main className="max-w-3xl mx-auto px-4 py-10">
      <div className="rounded-2xl border border-ppp-orange-100 bg-white p-6 text-center">
        <div
          aria-hidden
          className="mx-auto h-11 w-11 rounded-full bg-ppp-orange-50 border border-ppp-orange-100 flex items-center justify-center mb-4"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2.25" strokeLinecap="round" className="text-ppp-orange-700">
            <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
        </div>

        <h1 className="text-lg font-bold text-ppp-charcoal">This screen could not load</h1>
        <p className="mt-2 text-[13px] text-ppp-charcoal-500 leading-relaxed">
          Something went wrong reading the data, so nothing is shown rather than
          something wrong. <strong>No message was sent or missed because of this</strong> —
          replies are queued in the database and the tick keeps running.
        </p>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="min-h-[44px] px-4 rounded-lg bg-ppp-charcoal text-white text-[13px] font-medium touch-manipulation"
          >
            Try again
          </button>
          <Link
            href="/messaging"
            className="min-h-[44px] px-4 rounded-lg border border-ppp-charcoal-200 text-ppp-charcoal text-[13px] font-medium inline-flex items-center touch-manipulation"
          >
            Back to the inbox
          </Link>
        </div>

        {error.digest && (
          // The one string that ties what they saw to a line in the server
          // logs. Worth more than any message we could write here.
          <p className="mt-5 text-[11px] font-mono text-ppp-charcoal-400">
            Reference: {error.digest}
          </p>
        )}
      </div>
    </main>
  );
}
