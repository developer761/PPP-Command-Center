import Link from "next/link";
import { trainingStats, loadTrainingCoverage } from "@/lib/messaging/db";

export const dynamic = "force-dynamic";

/**
 * Training — the landing page.
 *
 * Rewritten because the first version led with four zeroes and a paragraph
 * about retrieval. Kate arrives here to DO something, and the page should say
 * what those things are before it says how many of them have been done.
 *
 * Three jobs, in the order they make sense: see how it behaves, teach it from
 * real conversations, and check what is still missing.
 */
export default async function TrainingPage() {
  const [s, cov] = await Promise.all([trainingStats(), loadTrainingCoverage()]);
  const needsWork = s.needsScrub + s.needsReview + cov.ungraded + cov.gradedNoReason;

  const jobs = [
    {
      href: "/messaging/training/simulator",
      title: "Try the bot",
      blurb: "Play a customer and watch what it does. Nothing here can text anybody.",
      meta: "Start here",
      primary: true,
    },
    {
      href: "/messaging/training/grade",
      title: "Grade conversations",
      blurb: "Read a real conversation, say whether it was handled well, and tick which rules it shows.",
      meta: cov.ungraded > 0 ? `${cov.ungraded} waiting` : s.total === 0 ? "Nothing imported yet" : "All graded",
      primary: false,
    },
    {
      href: "/messaging/training/import",
      title: "Import from Hatch",
      blurb: "Paste an export. Personal details are removed in your browser before anything is sent.",
      meta: s.total > 0 ? `${s.total} imported` : "Nothing yet — start here",
      primary: s.total === 0,
    },
    {
      href: "/messaging/training/coverage",
      title: "What it covers",
      blurb: "Which of Emily's rules still have no good example behind them.",
      meta: cov.summary.missing > 0 ? `${cov.summary.missing} rules with nothing` : `${cov.summary.covered} covered`,
      primary: false,
    },
  ];

  return (
    <main className="max-w-3xl mx-auto px-4 py-4 pb-safe space-y-4">
      <header>
        <h1 className="text-lg font-bold text-ppp-charcoal">Training</h1>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          Teaching the bot what a good conversation looks like, and checking it
          still behaves after the rules change.
        </p>
      </header>

      <nav className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {jobs.map((j) => (
          <Link key={j.href} href={j.href}
            className={[
              "group rounded-xl border-2 bg-white px-4 py-3.5 transition-colors touch-manipulation",
              j.primary ? "border-ppp-charcoal hover:bg-ppp-charcoal-50" : "border-ppp-charcoal-100 hover:border-ppp-charcoal-200",
            ].join(" ")}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-semibold text-ppp-charcoal">{j.title}</span>
              <span className="shrink-0 text-[11px] text-ppp-charcoal-400">{j.meta}</span>
            </div>
            <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">{j.blurb}</p>
          </Link>
        ))}
      </nav>

      {/* Each line says what it MEANS and what to do about it, and links
          straight there. The first version said things like "4 scrubbed but
          not approved", which does not tell a reader what was scrubbed, who
          approves, what approval is for, or what they are supposed to do —
          Karan read it and asked what it meant, which is the whole answer. */}
      {needsWork > 0 && (
        <section className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 overflow-hidden">
          <p className="px-4 py-2.5 text-[13px] font-semibold text-ppp-orange-700 border-b border-ppp-orange-100">
            {needsWork} thing{needsWork === 1 ? "" : "s"} the bot is waiting on
          </p>
          <ul className="divide-y divide-ppp-orange-100">
            {cov.ungraded > 0 && (
              <li>
                <Link href="/messaging/training/grade" className="block px-4 py-2.5 touch-manipulation">
                  <p className="text-[12.5px] font-medium text-ppp-orange-700">
                    {cov.ungraded} conversation{cov.ungraded === 1 ? "" : "s"} nobody has judged yet
                  </p>
                  <p className="mt-0.5 text-[12px] text-ppp-orange-700/80 leading-relaxed">
                    Until somebody says whether each one went well, the bot cannot
                    tell them apart from the ones that went badly. Grade them →
                  </p>
                </Link>
              </li>
            )}
            {cov.gradedNoReason > 0 && (
              <li>
                <Link href="/messaging/training/grade" className="block px-4 py-2.5 touch-manipulation">
                  <p className="text-[12.5px] font-medium text-ppp-orange-700">
                    {cov.gradedNoReason} judged, but with no reason given
                  </p>
                  <p className="mt-0.5 text-[12px] text-ppp-orange-700/80 leading-relaxed">
                    &ldquo;This one was good&rdquo; teaches nothing on its own. Tick which
                    of Emily&rsquo;s rules it shows and it starts teaching that rule. Add reasons →
                  </p>
                </Link>
              </li>
            )}
            {s.needsScrub > 0 && (
              <li>
                <Link href="/messaging/training/import" className="block px-4 py-2.5 touch-manipulation">
                  <p className="text-[12.5px] font-medium text-ppp-orange-700">
                    {s.needsScrub} still contain{s.needsScrub === 1 ? "s" : ""} somebody&rsquo;s personal details
                  </p>
                  <p className="mt-0.5 text-[12px] text-ppp-orange-700/80 leading-relaxed">
                    Names, numbers and addresses. These are held back and never
                    reach the bot until they are cleaned. Re-import them →
                  </p>
                </Link>
              </li>
            )}
            {s.needsReview > 0 && (
              <li>
                <Link href="/messaging/training/grade" className="block px-4 py-2.5 touch-manipulation">
                  <p className="text-[12.5px] font-medium text-ppp-orange-700">
                    {s.needsReview} cleaned up and ready, but not signed off
                  </p>
                  <p className="mt-0.5 text-[12px] text-ppp-orange-700/80 leading-relaxed">
                    The personal details are gone. What is missing is somebody
                    saying &ldquo;yes, copy this one&rdquo; — the bot only imitates
                    conversations a person has approved. Sign them off →
                  </p>
                </Link>
              </li>
            )}
          </ul>
        </section>
      )}

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <h2 className="px-4 py-2.5 border-b border-ppp-charcoal-100 font-semibold text-ppp-charcoal text-[14px]">
          Where the corpus stands
        </h2>
        <div className="px-4 py-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {([
            ["Conversations in total", s.total, "Everything imported or written by hand."],
            ["The bot can copy", s.byConduct.good, "Good, cleaned up and signed off."],
            ["The bot avoids", s.byConduct.bad, "Marked as handled badly. Used as warnings, never copied."],
            ["Not usable yet", Math.max(0, s.total - s.usable), "Still need cleaning, judging or signing off."],
          ] as const).map(([label, n, why]) => (
            <div key={label}>
              <div className="text-[20px] font-bold text-ppp-charcoal tabular-nums leading-none">{n}</div>
              <div className="mt-1 text-[11.5px] font-medium text-ppp-charcoal-600">{label}</div>
              <div className="mt-0.5 text-[11px] text-ppp-charcoal-400 leading-snug">{why}</div>
            </div>
          ))}
        </div>
        {s.total === 0 && (
          <p className="px-4 pb-3 text-[12px] text-ppp-charcoal-500 leading-relaxed">
            Nothing imported yet. The simulator works without any of this — it
            asks the bot directly.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3">
        <p className="text-[12.5px] text-ppp-charcoal-600 leading-relaxed">
          <strong>Real conversations</strong> teach the bot what good looks like.
          <strong className="ml-1">Simulator runs</strong> do not — a made-up
          customer is somebody&apos;s idea of a customer. They become tests
          instead, replayed after a rules change to see what broke.
        </p>
      </section>
    </main>
  );
}
