import Link from "next/link";
import { loadTrainingCoverage } from "@/lib/messaging/db";
import { THIN_THRESHOLD } from "@/lib/messaging/training-coverage";

export const dynamic = "force-dynamic";

const SECTION_LABEL: Record<string, string> = {
  flow: "The required flow", quote_type: "Quote type",
  qualification: "Qualifying the job", tone: "Tone",
  handling: "Awkward situations", ending: "Ending the conversation",
};

const STATUS: Record<string, { label: string; tone: "good" | "warn" | "bad" }> = {
  covered: { label: "Covered", tone: "good" },
  thin: { label: "Thin", tone: "warn" },
  only_counterexamples: { label: "Only bad examples", tone: "warn" },
  missing: { label: "Nothing yet", tone: "bad" },
};

/**
 * Corpus coverage.
 *
 * Row count is a bad measure. Five hundred conversations that all show the same
 * three rules teach less than fifty covering twenty, because retrieval picks by
 * similarity — an untagged corpus surfaces whatever LOOKS like the current
 * conversation rather than whatever demonstrates the rule it needs.
 *
 * So this page answers "which of Emily's rules has nothing to show for it",
 * which is a list somebody can go and work through.
 */
export default async function TrainingCoverage() {
  const { coverage, summary, ungraded, gradedNoReason } = await loadTrainingCoverage();

  const bySection = new Map<string, typeof coverage>();
  for (const c of coverage) {
    const list = bySection.get(c.tag.section) ?? [];
    list.push(c);
    bySection.set(c.tag.section, list);
  }

  return (
    <main className="max-w-3xl mx-auto px-4 py-4 pb-safe space-y-4">
      <Link href="/messaging/training"
        className="inline-flex items-center gap-1.5 min-h-[44px] -ml-1 px-1 text-[13px] font-medium text-ppp-charcoal-500 hover:text-ppp-charcoal touch-manipulation">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M19 12H5 M12 19l-7-7 7-7" />
        </svg>
        Training
      </Link>

      <header>
        <h1 className="text-lg font-bold text-ppp-charcoal">What the corpus actually covers</h1>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          Emily follows about twenty rules. A conversation marked good with
          nothing else attached cannot teach any of them, so each example says
          which rules it demonstrates — and this is what is still missing.
        </p>
        <p className="mt-2 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          Three ways to fill a gap: <strong>write one</strong> if you already
          know what a good version says, <strong>grade an imported one</strong>
          if Hatch has an example, or <strong>try it in the simulator</strong> —
          that produces a test rather than an example, but it tells you whether
          the bot gets the rule right at all.
        </p>
      </header>

      <section className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {([
          ["Covered", summary.covered, "good"],
          ["Thin", summary.thin, "warn"],
          ["Only bad", summary.onlyCounterexamples, "warn"],
          ["Nothing yet", summary.missing, "bad"],
        ] as const).map(([label, n, tone]) => (
          <div key={label} className={[
            "rounded-xl px-3 py-3",
            tone === "good" ? "bg-ppp-green-50" : tone === "warn" ? "bg-ppp-orange-50" : "bg-ppp-charcoal-50",
          ].join(" ")}>
            <div className={[
              "text-[22px] font-bold tabular-nums leading-none",
              tone === "good" ? "text-ppp-green-700" : tone === "warn" ? "text-ppp-orange-700" : "text-ppp-charcoal",
            ].join(" ")}>{n}</div>
            <div className="mt-1 text-[11.5px] text-ppp-charcoal-600">{label}</div>
          </div>
        ))}
      </section>

      {(ungraded > 0 || gradedNoReason > 0) && (
        <section className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 px-4 py-3">
          {gradedNoReason > 0 && (
            <p className="text-[13px] text-ppp-orange-700 leading-relaxed">
              <strong>{gradedNoReason}</strong> example{gradedNoReason === 1 ? " has" : "s have"} a
              grade but no reason. &ldquo;Good&rdquo; on its own tells retrieval it
              was good at <em>something</em>, which is not a signal it can use.
            </p>
          )}
          {ungraded > 0 && (
            <p className={`text-[13px] text-ppp-orange-700 leading-relaxed ${gradedNoReason > 0 ? "mt-1.5" : ""}`}>
              <strong>{ungraded}</strong> not graded yet.
            </p>
          )}
        </section>
      )}

      {summary.gaps.length > 0 && (
        <section className="rounded-xl border-2 border-ppp-charcoal-200 bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
            <h2 className="font-semibold text-ppp-charcoal text-[14px]">Go and find these</h2>
            <p className="mt-0.5 text-[12px] text-ppp-charcoal-500">
              Worst first. A rule needs {THIN_THRESHOLD} good examples before retrieval can lean on it.
            </p>
          </div>
          <ul className="divide-y divide-ppp-charcoal-100">
            {summary.gaps.slice(0, 8).map((c) => (
              <li key={c.tag.key} className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] font-medium text-ppp-charcoal">{c.tag.label}</span>
                  <span className={[
                    "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
                    STATUS[c.status].tone === "bad" ? "bg-ppp-charcoal-100 text-ppp-charcoal-600" : "bg-ppp-orange-50 text-ppp-orange-700",
                  ].join(" ")}>
                    {c.usableGood}/{THIN_THRESHOLD}
                  </span>
                </div>
                <p className="mt-1 text-[12px] text-ppp-charcoal-500 leading-relaxed">{c.tag.what_to_look_for}</p>
                {c.bad > 0 && c.usableGood === 0 && (
                  <p className="mt-1 text-[12px] text-ppp-orange-700">
                    {c.bad} example{c.bad === 1 ? "" : "s"} of getting this wrong, none of getting it right.
                  </p>
                )}
                {/* Somewhere to go. The first version named the gap and
                    stopped, which is why the page read as a wall rather than
                    a worklist. */}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Link href={`/messaging/training/simulator?tag=${c.tag.key}`}
                    className="inline-flex items-center min-h-[34px] px-2.5 rounded-lg border border-ppp-charcoal-200 bg-white text-[12px] font-medium text-ppp-charcoal touch-manipulation">
                    Try it in the simulator
                  </Link>
                  <Link href={`/messaging/training/write?tag=${c.tag.key}`}
                    className="inline-flex items-center min-h-[34px] px-2.5 rounded-lg border border-ppp-charcoal-200 bg-white text-[12px] font-medium text-ppp-charcoal touch-manipulation">
                    Write one
                  </Link>
                  <Link href="/messaging/training/grade"
                    className="inline-flex items-center min-h-[34px] px-2.5 rounded-lg text-[12px] font-medium text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 touch-manipulation">
                    Grade imported
                  </Link>
                </div>
              </li>
            ))}
          </ul>
          {summary.gaps.length > 8 && (
            <p className="px-4 py-2.5 text-[12px] text-ppp-charcoal-500 border-t border-ppp-charcoal-100">
              and {summary.gaps.length - 8} more below
            </p>
          )}
        </section>
      )}

      {[...bySection.entries()].map(([section, items]) => (
        <section key={section} className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
          <h2 className="px-4 py-2.5 border-b border-ppp-charcoal-100 font-semibold text-ppp-charcoal text-[14px]">
            {SECTION_LABEL[section] ?? section}
          </h2>
          <ul className="divide-y divide-ppp-charcoal-50">
            {items.map((c) => (
              <li key={c.tag.key} className="px-4 py-2.5 flex items-center gap-3">
                <span aria-hidden className={[
                  "shrink-0 h-2 w-2 rounded-full",
                  c.status === "covered" ? "bg-ppp-green-700"
                    : c.status === "missing" ? "bg-ppp-charcoal-300" : "bg-ppp-orange-500",
                ].join(" ")} />
                <span className="flex-1 min-w-0 text-[13px] text-ppp-charcoal truncate">{c.tag.label}</span>
                <span className="shrink-0 text-[11.5px] tabular-nums text-ppp-charcoal-400">
                  {c.usableGood > 0 && <span className="text-ppp-green-700 font-medium">{c.usableGood} good</span>}
                  {c.usableGood > 0 && c.bad > 0 && " · "}
                  {c.bad > 0 && <span>{c.bad} bad</span>}
                  {c.usableGood === 0 && c.bad === 0 && STATUS[c.status].label.toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
