import Link from "next/link";

export default function DashboardNotFound() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white border border-ppp-charcoal-100 rounded-2xl shadow-lg p-8 text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-ppp-blue-50 border border-ppp-blue-100 flex items-center justify-center mb-4">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ppp-blue" aria-hidden>
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35 M11 8v3 M11 14h.01" />
          </svg>
        </div>
        <h1 className="font-condensed text-xl font-bold text-ppp-navy uppercase tracking-tight">
          Page not found
        </h1>
        <p className="mt-2 text-sm text-ppp-charcoal-600">
          We couldn&apos;t find that rep, account, or section. Check the URL or
          go back to the dashboard.
        </p>
        <div className="mt-6">
          <Link
            href="/dashboard"
            className="inline-flex px-4 py-2 rounded-lg bg-ppp-blue text-white text-sm font-medium hover:bg-ppp-blue-600 transition-colors"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
