import Link from "next/link";

/**
 * A messaging page that does not exist, or a conversation that does not.
 *
 * Without this, notFound() rendered Next's default 404 OUTSIDE the messaging
 * shell — no nav, no sidebar, no way back to the inbox except the browser
 * button. The thread page calls notFound() whenever loadThread returns null,
 * which until recently also happened when the query merely FAILED, so a
 * database blip told Kate a real conversation did not exist.
 */
export default function MessagingNotFound() {
  return (
    <main className="max-w-3xl mx-auto px-4 py-10">
      <div className="rounded-2xl border border-ppp-charcoal-100 bg-white p-6 text-center">
        <h1 className="text-lg font-bold text-ppp-charcoal">Not found</h1>
        <p className="mt-2 text-[13px] text-ppp-charcoal-500 leading-relaxed">
          That conversation or page is not here. It may have been ended and
          cleared, or the link may be out of date.
        </p>
        <Link
          href="/messaging"
          className="mt-5 min-h-[44px] px-4 rounded-lg bg-ppp-charcoal text-white text-[13px] font-medium inline-flex items-center touch-manipulation"
        >
          Back to the inbox
        </Link>
      </div>
    </main>
  );
}
