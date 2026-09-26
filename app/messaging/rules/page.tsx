import Link from "next/link";
import { loadRuleOverview, rankRules } from "@/lib/messaging/rules-db";
import { assertMessagingAccess } from "@/lib/messaging/auth";

export const dynamic = "force-dynamic";

/**
 * The rules the bot is written against, ordered by how often it breaks them.
 *
 * Kate, 2026-09-22: "a section in the connect hub for the established bot
 * rules… and a section for tagged conversations to see the good vs the bad of
 * that rule + determine if it needs updating."
 *
 * ORDERED BY BREACHES, NOT BY CODE. In code order this is a reference
 * document nobody opens twice. Ordered by what the bot actually gets wrong it
 * is a to-do list, and the top line — A23, punctuation, 27% of every defect
 * she marked — is the most useful sentence on the page.
 */
export default async function RulesPage() {
  await assertMessagingAccess();
  const all = rankRules(await loadRuleOverview());
  const live = all.filter((r) => r.status === "live");
  const retired = all.filter((r) => r.status === "retired");

  const totalBreaches = live.reduce((n, r) => n + r.counts.fellShort, 0);
  const graded = live.some((r) => r.counts.fellShort + r.counts.didWell > 0);

  return (
    <main className="max-w-4xl mx-auto px-4 py-4 pb-safe space-y-4">
      <header>
        <h1 className="font-bold text-ppp-charcoal">Rules</h1>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          What the bot is written against, and what it is graded against — the
          same list, so the two cannot drift. Ordered by how often each one is
          actually broken.
        </p>
      </header>

      {graded && (
        <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3">
          <p className="text-[13px] text-ppp-charcoal-600 leading-relaxed">
            <strong>{totalBreaches.toLocaleString()}</strong> breaches across{" "}
            <strong>{live.length}</strong> live rules.{" "}
            {live[0] && live[0].counts.fellShort > 0 && (
              <>
                <Link href={`/messaging/rules/${live[0].code}`} className="underline underline-offset-2">
                  {live[0].code}
                </Link>{" "}
                alone accounts for{" "}
                {Math.round((live[0].counts.fellShort / Math.max(totalBreaches, 1)) * 100)}% of them.
              </>
            )}
          </p>
        </section>
      )}

      <ul className="space-y-1.5">
        {live.map((r) => (
          <li key={r.code}>
            <Link
              href={`/messaging/rules/${r.code}`}
              className="block rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3 touch-manipulation"
            >
              <div className="flex items-baseline gap-2.5">
                <span className="font-mono text-[12px] font-semibold text-ppp-charcoal-500 shrink-0">{r.code}</span>
                {r.severity === "critical" && (
                  <span className="shrink-0 rounded-full bg-ppp-orange-50 px-2 py-0.5 text-[10px] font-semibold text-ppp-orange-700">
                    critical
                  </span>
                )}
                {/* THE STATEMENT IS THE TITLE, because it is the rule.
                    short_name is a CATEGORY, not a name: "Tone",
                    "Disposition", "Misc Awkward", "Intent". Twelve of the 35
                    live rules share one with another rule, so titling by it
                    put two different rules called "Tone" and two called
                    "Disposition" on this screen, while rules with no category
                    were correctly titled by their statement. Same list, two
                    kinds of heading, and the duplicates named nothing. */}
                <span className="text-[13.5px] font-medium text-ppp-charcoal leading-snug line-clamp-2">
                  {r.statement}
                </span>
                {r.shortName && (
                  <span className="shrink-0 rounded-full bg-ppp-charcoal-50 px-2 py-0.5 text-[10px] font-medium text-ppp-charcoal-500">
                    {r.shortName}
                  </span>
                )}
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] font-mono">
                {/* The number worth acting on comes first and is the only one
                    colored — a list where everything is highlighted says
                    nothing about what to do next. */}
                <span className={r.counts.fellShort > 0 ? "text-ppp-orange-700" : "text-ppp-charcoal-400"}>
                  {r.counts.fellShort} breached
                </span>
                <span className="text-ppp-charcoal-400">{r.counts.didWell} done well</span>
                <span className="text-ppp-charcoal-400">
                  {r.counts.conversations} conversation{r.counts.conversations === 1 ? "" : "s"}
                </span>
              </div>
            </Link>
          </li>
        ))}
      </ul>

      {retired.length > 0 && (
        <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3">
          <h2 className="text-[13px] font-semibold text-ppp-charcoal">{retired.length} retired</h2>
          <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
            Kept rather than deleted. A merged rule still explains an old
            grading, and deleting one is how its code gets reused by accident —
            A37 and A42 are burned in Kate&apos;s sheet for exactly that reason.
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {retired.map((r) => (
              <li key={r.code}>
                <Link
                  href={`/messaging/rules/${r.code}`}
                  className="inline-flex items-center rounded-lg bg-ppp-charcoal-100 px-2 py-1 font-mono text-[11px] text-ppp-charcoal-500 touch-manipulation"
                >
                  {r.code}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
