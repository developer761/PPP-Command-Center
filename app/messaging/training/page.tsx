import { trainingStats } from "@/lib/messaging/db";

export const dynamic = "force-dynamic";

/**
 * Training corpus.
 *
 * The whole page turns on one distinction: a conversation can be well HANDLED
 * and still lose, or badly handled and get lucky with a motivated customer.
 * Label only by outcome and the model learns to imitate luck — it copies the
 * conversations that happened to book, including the sloppy ones.
 *
 * So conduct and outcome are separate, and the screen leads with whether they
 * actually disagree in PPP's own data. If they never disagree, one label is
 * doing no work and the corpus is weaker than its row count suggests.
 */
export default async function TrainingPage() {
  const s = await trainingStats();
  const disagree = s.goodButLost + s.badButBooked;

  return (
    <main className="max-w-3xl mx-auto px-4 py-4 pb-safe space-y-4">
      <header>
        <h1 className="text-lg font-bold text-ppp-charcoal">Training corpus</h1>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          Past Hatch conversations, used as retrieval examples rather than for
          fine-tuning — faster, inspectable, and a bad example can be deleted
          instead of retrained away.
        </p>
      </header>

      <section className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          ["Imported", s.total, "conversations"],
          ["Usable", s.usable, "scrubbed + approved"],
          ["Needs scrubbing", s.needsScrub, "PII still present"],
          ["Needs review", s.needsReview, "awaiting a human"],
        ].map(([label, value, note]) => (
          <div key={label as string} className="rounded-xl border border-ppp-charcoal-100 bg-white px-3 py-3">
            <div className="text-[22px] font-bold text-ppp-charcoal tabular-nums leading-none">{value as number}</div>
            <div className="mt-1 text-[12px] font-medium text-ppp-charcoal">{label}</div>
            <div className="mt-0.5 text-[11px] text-ppp-charcoal-400 leading-tight">{note}</div>
          </div>
        ))}
      </section>

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-4">
        <h2 className="font-semibold text-ppp-charcoal text-[14px]">Conduct and outcome are labelled separately</h2>
        <p className="mt-1.5 text-[12.5px] text-ppp-charcoal-600 leading-relaxed">
          A conversation can be handled well and still lose an unqualified lead,
          or handled badly and book anyway because the customer was already
          decided. Trained on outcome alone, the model imitates luck.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-ppp-charcoal-50 px-3 py-2.5">
            <div className="text-[18px] font-bold text-ppp-charcoal tabular-nums leading-none">{s.goodButLost}</div>
            <div className="mt-1 text-[11.5px] text-ppp-charcoal-600 leading-snug">Handled well, did not book</div>
          </div>
          <div className="rounded-lg bg-ppp-charcoal-50 px-3 py-2.5">
            <div className="text-[18px] font-bold text-ppp-charcoal tabular-nums leading-none">{s.badButBooked}</div>
            <div className="mt-1 text-[11.5px] text-ppp-charcoal-600 leading-snug">Handled badly, booked anyway</div>
          </div>
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-ppp-charcoal-500">
          {s.total === 0
            ? "Nothing imported yet, so there is nothing to disagree about."
            : disagree > 0
            ? `The two labels disagree on ${disagree} conversation${disagree === 1 ? "" : "s"} — which is the point. Those are exactly the examples an outcome-only corpus would get wrong.`
            : "The two labels agree on every row so far. Worth checking the grading: if conduct is being inferred from whether it booked, one of these columns is doing no work and the corpus is weaker than its row count suggests."}
        </p>
      </section>

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <h2 className="px-4 py-2.5 border-b border-ppp-charcoal-100 font-semibold text-ppp-charcoal text-[14px]">By conduct</h2>
        <ul className="divide-y divide-ppp-charcoal-100">
          {[
            ["good", "Good", s.byConduct.good, "Used as positive retrieval examples."],
            ["mixed", "Mixed", s.byConduct.mixed, "Kept for context, not offered as a model reply."],
            ["bad", "Bad", s.byConduct.bad, "Used only to describe what not to do."],
            ["unlabelled", "Unlabelled", s.byConduct.unlabelled, "Not eligible for retrieval until graded."],
          ].map(([key, label, n, note]) => (
            <li key={key as string} className="px-4 py-3 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-ppp-charcoal">{label}</p>
                <p className="mt-0.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">{note}</p>
              </div>
              <span className="shrink-0 text-[15px] font-bold text-ppp-charcoal tabular-nums">{n as number}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 px-4 py-3">
        <p className="text-[13px] font-semibold text-ppp-orange-700">PII is stripped before anything reaches a model</p>
        <p className="mt-1.5 text-[12.5px] text-ppp-orange-700/90 leading-relaxed">
          Names, addresses and phone numbers come out first. Only rows that are
          both scrubbed and approved by a person are eligible for retrieval —
          an unreviewed transcript is a customer&apos;s conversation, not a
          training example.
        </p>
      </section>

      {s.total === 0 && (
        <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-5 py-8 text-center">
          <p className="font-semibold text-ppp-charcoal">Nothing imported yet</p>
          <p className="mt-2 text-[13px] text-ppp-charcoal-500 leading-relaxed max-w-md mx-auto">
            The corpus is the Google Sheet of past Hatch conversations. Before
            importing, it needs one thing settled: whether the existing good/bad
            grades describe how the conversation was HANDLED or whether it
            BOOKED. They are different signals and the import stores them in
            different columns.
          </p>
        </section>
      )}
    </main>
  );
}
