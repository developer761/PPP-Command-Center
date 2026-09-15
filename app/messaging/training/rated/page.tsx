import Link from "next/link";
import { ratedConversations } from "@/lib/messaging/repair-write";

export const dynamic = "force-dynamic";

const FILTERS = [
  ["rated", "Rated by you"],
  ["repaired", "Repaired"],
  ["unsigned", "Repair not signed off"],
  ["good", "Good"],
  ["mixed", "Mixed"],
  ["bad", "Bad"],
  ["all", "All"],
] as const;
type Filter = (typeof FILTERS)[number][0];

const GRADE: Record<string, string> = { good: "Good", mixed: "Mixed", bad: "Bad" };

/**
 * Kate: "How can I see the already rated conversations?"
 *
 * Grading one took it off the only screen that showed it, so finished work had
 * nowhere to be found and nothing could be corrected afterwards.
 */
export default async function RatedPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const { show } = await searchParams;
  const filter: Filter = (FILTERS.some(([k]) => k === show) ? show : "rated") as Filter;
  const rows = await ratedConversations();

  const count = (f: Filter) => rows.filter((r) => matches(r, f)).length;
  const visible = rows.filter((r) => matches(r, filter));

  return (
    <main className="max-w-3xl mx-auto px-4 py-4 pb-safe space-y-4">
      <Link href="/messaging/training"
        className="inline-flex items-center gap-1.5 min-h-[44px] -ml-1 px-1 text-[13px] font-medium text-ppp-charcoal-500 touch-manipulation">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M19 12H5 M12 19l-7-7 7-7" />
        </svg>
        Training
      </Link>

      <header>
        <h1 className="text-lg font-bold text-ppp-charcoal">Rated conversations</h1>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          Everything that has been graded or repaired. Open one to read it with
          turn numbers, change its grade, or fix more lines.
        </p>
      </header>

      <nav className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
        {FILTERS.map(([key, label]) => (
          <Link key={key} href={`/messaging/training/rated?show=${key}`}
            className={[
              "shrink-0 min-h-[36px] px-3 rounded-lg text-[12.5px] font-medium flex items-center gap-1.5 whitespace-nowrap touch-manipulation",
              filter === key ? "bg-ppp-charcoal text-white" : "bg-white border border-ppp-charcoal-200 text-ppp-charcoal-600",
            ].join(" ")}>
            {label}
            <span className={filter === key ? "text-white/70" : "text-ppp-charcoal-400"}>{count(key)}</span>
          </Link>
        ))}
      </nav>

      {visible.length === 0 ? (
        <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-5 py-8 text-center">
          <p className="text-[13px] text-ppp-charcoal-500 leading-relaxed">
            {filter === "rated"
              ? "Nothing graded or repaired here yet. Conversations you grade or repair show up in this list."
              : "Nothing in this group."}
          </p>
        </section>
      ) : (
        <ul className="rounded-xl border border-ppp-charcoal-100 bg-white divide-y divide-ppp-charcoal-100 overflow-hidden">
          {visible.map((r) => (
            <li key={r.id}>
              <Link href={`/messaging/training/rated/${r.id}`}
                className="block px-4 py-3 min-h-[56px] hover:bg-ppp-charcoal-50 touch-manipulation">
                <div className="flex flex-wrap items-center gap-1.5">
                  {r.conduct && (
                    <span className={[
                      "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                      r.conduct === "good" ? "bg-ppp-green-50 text-ppp-charcoal"
                        : r.conduct === "bad" ? "bg-ppp-orange-50 text-ppp-orange-700"
                        : "bg-ppp-charcoal-50 text-ppp-charcoal-600",
                    ].join(" ")}>{GRADE[r.conduct] ?? r.conduct}</span>
                  )}
                  <span className="text-[11.5px] text-ppp-charcoal-500">
                    {r.turns} turns · {r.rules} rule{r.rules === 1 ? "" : "s"}
                    {r.repairs.total > 0 && (
                      <> · {r.repairs.total} repair{r.repairs.total === 1 ? "" : "s"}
                        {r.repairs.signed < r.repairs.total ? `, ${r.repairs.total - r.repairs.signed} not signed off` : ", signed off"}</>
                    )}
                  </span>
                </div>
                <p className="mt-1 text-[12.5px] text-ppp-charcoal leading-snug">{r.firstLine || "(empty)"}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function matches(r: Awaited<ReturnType<typeof ratedConversations>>[number], f: Filter): boolean {
  switch (f) {
    case "all": return true;
    case "rated": return r.ratedByPerson;
    case "repaired": return r.repairs.total > 0;
    case "unsigned": return r.repairs.total > r.repairs.signed;
    default: return r.conduct === f;
  }
}
