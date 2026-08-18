"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Error boundary for the whole Commercial segment.
 *
 * The residential dashboard has had one of these for a while; Commercial never
 * did, and neither did the root. So anything that threw during a render — a
 * Supabase hiccup, a record in a shape nothing expected, a PDF that failed to
 * build — dropped the user onto Next's default screen: a bare "Application
 * error: a client-side exception has occurred", no branding, no way back, and
 * nothing to quote when they call Karan about it.
 *
 * This is the screen someone sees on the worst day. Keep it calm, keep it
 * branded, and give them the two things they actually need: a retry, and a way
 * out. The digest is printed because it's the one string that ties what they
 * saw to a line in the server logs.
 */
export default function CommercialError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[commercial] render error", {
      digest: error.digest,
      message: error.message,
    });
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4 py-10">
      <div className="max-w-md w-full bg-surface border border-ppp-charcoal-100 rounded-2xl shadow-lg p-7 sm:p-8 text-center">
        <div
          aria-hidden
          className="mx-auto h-12 w-12 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center mb-4"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-amber-700"
          >
            <path d="M12 9v4 M12 17h.01 M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          </svg>
        </div>

        <h1 className="text-lg font-bold text-ppp-charcoal tracking-tight">
          This page didn&rsquo;t load
        </h1>
        <p className="mt-2 text-[13.5px] text-ppp-charcoal-600 leading-relaxed">
          Something went wrong while building this screen. Nothing you were
          working on has been lost &mdash; try again, and if it keeps happening,
          send the reference below to Karan.
        </p>

        {error.digest && (
          <p className="mt-3 text-[11px] text-ppp-charcoal-500 font-mono break-all">
            Ref: {error.digest}
          </p>
        )}

        <div className="mt-6 flex flex-col sm:flex-row gap-2.5 justify-center">
          <button
            type="button"
            onClick={() => reset()}
            className="min-h-[44px] px-5 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 transition-colors touch-manipulation"
          >
            Try again
          </button>
          <Link
            href="/commercial"
            className="min-h-[44px] inline-flex items-center justify-center px-5 py-2.5 rounded-lg border border-ppp-charcoal-200 text-sm font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 transition-colors touch-manipulation"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
