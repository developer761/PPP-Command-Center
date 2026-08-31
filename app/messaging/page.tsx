/**
 * Messaging home — placeholder shell.
 *
 * The inbox lands in Stage 4. This exists now so the third picker tile has
 * somewhere real to go and the access gate can be exercised end to end before
 * any of the substrate is wired.
 */
export default function MessagingPage() {
  return (
    <main className="max-w-3xl mx-auto px-5 py-10">
      <p className="text-[11px] font-bold tracking-widest uppercase text-ppp-orange-700">
        Messaging
      </p>
      <h1 className="mt-1 text-2xl font-bold text-ppp-charcoal">
        Nothing here yet
      </h1>
      <p className="mt-3 text-sm text-ppp-charcoal-500 leading-relaxed">
        The conversation inbox is being built. This surface will hold lead
        nurture, follow-ups, coordination and post-job surveys over SMS —
        replacing Hatch.
      </p>
      <div className="mt-6 rounded-xl border border-ppp-charcoal-100 bg-white p-5">
        <p className="text-[11px] font-bold tracking-widest uppercase text-ppp-charcoal-500">
          Access
        </p>
        <p className="mt-2 text-sm text-ppp-charcoal-600 leading-relaxed">
          You are seeing this because your profile has <code>has_messaging_access</code>.
          It defaults off and is granted per person — this surface can text
          customers, so nobody inherits it.
        </p>
      </div>
    </main>
  );
}
