import Link from "next/link";
import { notFound } from "next/navigation";
import { loadRuleDetail, EXAMPLES_PER_KIND, type RuleFinding, type RuleChangeEntry } from "@/lib/messaging/rules-db";
import { describeChange } from "@/lib/messaging/rule-diff";
import { assertMessagingAccess } from "@/lib/messaging/auth";

export const dynamic = "force-dynamic";

/**
 * One rule: what it says, how it has changed, and the turns that prove it.
 *
 * THE RATER GUIDANCE IS SHOWN HERE. Kate's column is headed "RATER ONLY —
 * NEVER give this to a bot", which is about the MODEL rather than about
 * people: she is the rater, and it is written for whoever grades. It belongs
 * on a human screen and nowhere near a prompt. The separation is structural —
 * the guidance lives in its own table, and the loader that feeds the prompt
 * does not know that table exists.
 */
/** The stored row, in the shape describeChange reads. */
const describe = (c: RuleChangeEntry) =>
  describeChange({ code: "", field: c.field as never, before: c.before, after: c.after, changeType: c.changeType });

function Finding({ f }: { f: RuleFinding }) {
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-2 text-[11.5px] font-mono text-ppp-charcoal-400">
        {f.turnOrdinal !== null && <span>Turn {f.turnOrdinal}</span>}
        {f.severity && (
          <span className={f.severity === "critical" ? "text-ppp-orange-700" : undefined}>{f.severity}</span>
        )}
        {f.conduct && <span>conversation graded {f.conduct}</span>}
        <Link href={`/messaging/training/rated/${f.exampleId}`} className="underline underline-offset-2">
          open
        </Link>
      </div>
      <p className="mt-1 text-[13px] text-ppp-charcoal leading-relaxed">{f.what}</p>
      {f.shouldHave && (
        // The most valuable field in her sheet: a correction teaches where a
        // complaint only labels.
        <p className="mt-1.5 text-[12.5px] text-ppp-green-700 leading-relaxed">
          <span className="font-semibold">Should have:</span> {f.shouldHave}
        </p>
      )}
    </li>
  );
}

export default async function RulePage({ params }: { params: Promise<{ code: string }> }) {
  await assertMessagingAccess();
  const { code } = await params;
  const d = await loadRuleDetail(code);
  if (!d) notFound();

  const { rule } = d;
  const retired = rule.status === "retired";

  return (
    <main className="max-w-3xl mx-auto px-4 py-3 pb-safe space-y-4">
      <Link
        href="/messaging/rules"
        className="inline-flex items-center gap-1.5 min-h-[44px] -ml-1 px-1 text-[13px] font-medium text-ppp-charcoal-500 touch-manipulation"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25"
             strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M19 12H5 M12 19l-7-7 7-7" />
        </svg>
        Rules
      </Link>

      <header>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[13px] font-semibold text-ppp-charcoal-500">{rule.code}</span>
          {rule.severity && (
            <span className={[
              "rounded-full px-2 py-0.5 text-[10px] font-semibold",
              rule.severity === "critical" ? "bg-ppp-orange-50 text-ppp-orange-700" : "bg-ppp-charcoal-100 text-ppp-charcoal-600",
            ].join(" ")}>
              {rule.severity}
            </span>
          )}
          {retired && (
            <span className="rounded-full bg-ppp-charcoal-100 px-2 py-0.5 text-[10px] font-semibold text-ppp-charcoal-500">
              retired
            </span>
          )}
          {rule.phrasingOnly && (
            <span className="rounded-full bg-ppp-charcoal-100 px-2 py-0.5 text-[10px] font-semibold text-ppp-charcoal-500">
              phrasing only
            </span>
          )}
        </div>
        <h1 className="mt-1.5 text-lg font-bold text-ppp-charcoal leading-snug">{rule.statement}</h1>
        {rule.shortName && <p className="mt-0.5 text-[12.5px] text-ppp-charcoal-500">{rule.shortName}</p>}
      </header>

      {!retired && (
        <section className="grid grid-cols-3 gap-2">
          {[
            { n: rule.counts.fellShort, label: "breached", tone: rule.counts.fellShort > 0 },
            { n: rule.counts.didWell, label: "done well", tone: false },
            { n: rule.counts.conversations, label: "conversations", tone: false },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-ppp-charcoal-100 bg-white px-3 py-2.5">
              <p className={[
                "font-mono text-lg font-semibold tabular-nums",
                s.tone ? "text-ppp-orange-700" : "text-ppp-charcoal",
              ].join(" ")}>{s.n.toLocaleString()}</p>
              <p className="text-[11.5px] text-ppp-charcoal-500">{s.label}</p>
            </div>
          ))}
        </section>
      )}

      {rule.correctiveAction && (
        <section className="rounded-xl border border-ppp-green-100 bg-ppp-green-50/40 px-4 py-3">
          <h2 className="text-[12px] font-semibold text-ppp-green-700">What good looks like</h2>
          <p className="mt-1 text-[13px] text-ppp-charcoal leading-relaxed">{rule.correctiveAction}</p>
        </section>
      )}

      {rule.ruleCard && (
        <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3">
          <h2 className="text-[12px] font-semibold text-ppp-charcoal">The rule in detail</h2>
          <p className="mt-1.5 text-[13px] text-ppp-charcoal leading-relaxed whitespace-pre-wrap">{rule.ruleCard}</p>
        </section>
      )}

      {/* Provenance. Kate asked for a change history so that six months from
          now "why did X improve" has an answer other than somebody's memory. */}
      <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3">
        <h2 className="text-[12px] font-semibold text-ppp-charcoal">Where it came from</h2>
        <dl className="mt-1.5 space-y-1 text-[12.5px]">
          {[
            ["Source", rule.source],
            ["Change type", rule.changeType],
            ["Last modified", rule.lastModified],
            ["Last re-rated", rule.lastReRated],
            ["Measured breaches", rule.measuredBreaches],
          ].filter(([, v]) => v).map(([k, v]) => (
            <div key={k as string} className="flex gap-2">
              <dt className="w-36 shrink-0 text-ppp-charcoal-400">{k}</dt>
              <dd className="text-ppp-charcoal-600">{v}</dd>
            </div>
          ))}
        </dl>
        {d.history && (
          <>
            <h3 className="mt-3 text-[12px] font-semibold text-ppp-charcoal">Background</h3>
            {/* Kate's own History column. She flagged that some of it "may only
                be relevant to the rule-building period", so it sits as
                background rather than being parsed into a timeline it was
                never written to be. What happens from here is recorded below. */}
            <p className="mt-1 text-[12.5px] text-ppp-charcoal-600 leading-relaxed whitespace-pre-wrap">{d.history}</p>
          </>
        )}
      </section>

      {/* THE CHANGE LOG. Written by the import when Kate re-issues her sheet,
          so it accumulates without anybody remembering to keep it. This is the
          half that makes "did a rule change cause that?" answerable later. */}
      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
          <h2 className="font-semibold text-ppp-charcoal text-[14px]">What has changed</h2>
        </div>
        {d.changes.length === 0 ? (
          <p className="px-4 py-3 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
            Nothing recorded yet. Changes are logged from the next time the rule
            sheet is imported, so this fills in as the rules move rather than
            needing anyone to keep it.
          </p>
        ) : (
          <ul className="divide-y divide-ppp-charcoal-100">
            {d.changes.map((c) => (
              <li key={c.id} className="px-4 py-2.5">
                <div className="flex flex-wrap items-baseline gap-2 text-[11.5px] font-mono text-ppp-charcoal-400">
                  <span>{new Date(c.changedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}</span>
                  {/* BINDING means the meaning moved; WORDING means it did not.
                      That is the distinction that matters when asking whether a
                      change could have moved the numbers. */}
                  {c.changeType && (
                    <span className={c.changeType === "BINDING" ? "text-ppp-orange-700" : undefined}>{c.changeType}</span>
                  )}
                  <span>{c.changedBy}</span>
                </div>
                <p className="mt-0.5 text-[13px] text-ppp-charcoal leading-relaxed">{describe(c)}</p>
                {c.note && <p className="mt-0.5 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">{c.note}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {d.ratingGuidance && (
        <section className="rounded-xl border border-ppp-charcoal-200 bg-ppp-charcoal-50 px-4 py-3">
          <h2 className="text-[12px] font-semibold text-ppp-charcoal">For whoever is grading</h2>
          <p className="mt-0.5 text-[11px] text-ppp-charcoal-400">
            Kate&apos;s rater guidance. Shown here and never given to the bot — it would
            teach it to argue with its own grader.
          </p>
          <p className="mt-1.5 text-[12.5px] text-ppp-charcoal-600 leading-relaxed whitespace-pre-wrap">
            {d.ratingGuidance}
          </p>
        </section>
      )}

      {[
        { title: `Where it fell short`, list: d.fellShort, total: rule.counts.fellShort },
        { title: `Where it got this right`, list: d.didWell, total: rule.counts.didWell },
      ].map((s) => s.list.length > 0 && (
        <section key={s.title} className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
            <h2 className="font-semibold text-ppp-charcoal text-[14px]">{s.title}</h2>
            {s.total > s.list.length && (
              <p className="mt-0.5 text-[11.5px] text-ppp-charcoal-400">
                {s.list.length} of {s.total.toLocaleString()}, newest first
              </p>
            )}
          </div>
          <ul className="divide-y divide-ppp-charcoal-100">
            {s.list.map((f) => <Finding key={f.id} f={f} />)}
          </ul>
        </section>
      ))}

      {d.fellShort.length === 0 && d.didWell.length === 0 && (
        <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-5 py-7 text-center">
          <p className="text-[13px] text-ppp-charcoal-500 leading-relaxed">
            No graded conversation has cited this rule yet — so there is nothing
            here to say whether the bot follows it.
          </p>
        </section>
      )}
    </main>
  );
}
