import Link from "next/link";
import { trainingStats, loadTrainingCoverage } from "@/lib/messaging/db";
import { repairQueue } from "@/lib/messaging/repair-write";

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
  const [s, cov, repairs] = await Promise.all([
    trainingStats(), loadTrainingCoverage(), repairQueue(100),
  ]);
  const needsWork = s.needsScrub + s.needsReview + cov.ungraded + cov.gradedNoReason;

  /**
   * ONE thing to do, chosen from the state rather than listed alongside five
   * others.
   *
   * Six equal cards is a wall, and the answer to "what should I do now" is
   * almost never "read all six and decide". It is whichever gap is currently
   * costing the most, and right now that is nearly always the same one: the
   * bot has almost nothing good to copy.
   */
  const nextUp =
    s.total === 0
      ? {
          href: "/messaging/training/import",
          title: "Import conversations from Hatch",
          why: "There is nothing to learn from yet. Paste an export and personal details are removed in your browser before anything is sent.",
        }
      : s.byConduct.good < 10 && repairs.length > 0
        ? {
            href: "/messaging/training/repair",
            title: `Fix a near-miss — ${repairs.length} waiting`,
            why: `The bot can copy ${s.byConduct.good} conversation${s.byConduct.good === 1 ? "" : "s"} and avoid ${s.byConduct.bad}. These nearly went right and Kate wrote down what should have happened, so rewriting one line turns each into an example worth copying.`,
          }
        : cov.ungraded > 0
          ? {
              href: "/messaging/training/grade",
              title: `Grade ${cov.ungraded} conversation${cov.ungraded === 1 ? "" : "s"}`,
              why: "Until somebody says whether each went well, the bot cannot tell them apart from the ones that went badly.",
            }
          : {
              href: "/messaging/training/simulator",
              title: "Try the bot",
              why: "Play a customer and watch what it does. Nothing here can text anybody.",
            };

  const jobs = [
    {
      href: "/messaging/training/simulator",
      title: "Try the bot",
      blurb: "Play a customer and watch what it does. Nothing here can text anybody.",
      meta: "Start here",
      primary: false,
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
      primary: false,
    },
    {
      href: "/messaging/training/repair",
      title: "Fix a near-miss",
      blurb: "A conversation that nearly went right, with Kate's note on what should have happened. Rewrite one line.",
      meta: "Builds good examples",
      primary: false,
    },
    {
      href: "/messaging/training/replay",
      title: "What changed",
      blurb: "Replay the conversations you have judged and see what a rule change broke.",
      meta: "After changing the rules",
      primary: false,
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

      {/* A strip, not a wall. It was four paragraph-length rows in the middle
          of the page — Karan: "make this smaller and on the top". The detail
          belongs on the screen that fixes it, not on the way past. */}
      {needsWork > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {[
            cov.ungraded > 0 && { n: cov.ungraded, label: "to judge", href: "/messaging/training/grade" },
            cov.gradedNoReason > 0 && { n: cov.gradedNoReason, label: "need a reason", href: "/messaging/training/grade" },
            s.needsScrub > 0 && { n: s.needsScrub, label: "still hold personal details", href: "/messaging/training/import" },
            s.needsReview > 0 && { n: s.needsReview, label: "await sign-off", href: "/messaging/training/grade" },
          ].filter(Boolean).map((x) => {
            const item = x as { n: number; label: string; href: string };
            return (
              <Link key={item.label} href={item.href}
                className="inline-flex items-center gap-1.5 min-h-[32px] px-2.5 rounded-full border border-ppp-charcoal-200 bg-white text-[12px] text-ppp-charcoal-600 touch-manipulation">
                <span className="font-semibold text-ppp-charcoal tabular-nums">{item.n}</span>
                {item.label}
              </Link>
            );
          })}
        </div>
      )}

      {/* The one worth doing, full width and first. */}
      <Link href={nextUp.href}
        className="block rounded-xl border-2 border-ppp-charcoal bg-white px-4 py-4 touch-manipulation">
        <span className="text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">
          Start here
        </span>
        <span className="mt-0.5 block text-[15px] font-bold text-ppp-charcoal">{nextUp.title}</span>
        <span className="mt-1 block text-[12.5px] text-ppp-charcoal-500 leading-relaxed">{nextUp.why}</span>
      </Link>

      <nav className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {jobs.filter((j) => j.href !== nextUp.href).map((j) => (
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
