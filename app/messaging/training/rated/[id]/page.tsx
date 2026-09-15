import Link from "next/link";
import { notFound } from "next/navigation";
import { ratedConversation } from "@/lib/messaging/repair-write";
import { turnsOf } from "@/lib/messaging/repair";
import { ContextRow } from "@/components/messaging/repair-console";

export const dynamic = "force-dynamic";

const GRADE: Record<string, string> = { good: "Handled well", mixed: "Mixed", bad: "Handled badly" };

/** One rated conversation: what it said, turn by turn, and everything done to it. */
export default async function RatedConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await ratedConversation(id);
  if (!d) notFound();

  const turns = turnsOf(d.transcript);
  // Which turns carry a note or a fix, so they can be marked in the thread.
  const flagged = new Map<number, string[]>();
  for (const f of d.findings) {
    if (f.turnOrdinal == null) continue;
    flagged.set(f.turnOrdinal, [...(flagged.get(f.turnOrdinal) ?? []), f.code ?? "note"]);
  }
  for (const r of d.repairs) for (const f of r.fixes) {
    flagged.set(f.turn, [...(flagged.get(f.turn) ?? []), "fixed"]);
  }

  return (
    <main className="max-w-3xl mx-auto px-4 py-4 pb-safe space-y-4">
      <Link href="/messaging/training/rated"
        className="inline-flex items-center gap-1.5 min-h-[44px] -ml-1 px-1 text-[13px] font-medium text-ppp-charcoal-500 touch-manipulation">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M19 12H5 M12 19l-7-7 7-7" />
        </svg>
        Rated conversations
      </Link>

      <header className="space-y-2">
        <h1 className="text-lg font-bold text-ppp-charcoal">
          {d.conduct ? GRADE[d.conduct] ?? d.conduct : "Not graded"}
        </h1>
        {d.ruleLabels.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {d.ruleLabels.map((l) => (
              <span key={l} className="rounded-full bg-ppp-charcoal-50 px-2.5 py-0.5 text-[11.5px] text-ppp-charcoal-600">{l}</span>
            ))}
          </div>
        ) : (
          <p className="text-[12.5px] text-ppp-charcoal-500">No rules ticked yet.</p>
        )}
        {d.note && <p className="text-[12.5px] text-ppp-charcoal-600 leading-relaxed whitespace-pre-wrap">{d.note}</p>}
        <div className="flex flex-wrap gap-2 pt-1">
          <Link href={`/messaging/training/grade?id=${d.id}`}
            className="inline-flex items-center min-h-[44px] px-4 rounded-xl border border-ppp-charcoal-200 bg-white text-[13px] font-semibold text-ppp-charcoal touch-manipulation">
            Change the grade
          </Link>
          <Link href={`/messaging/training/repair?example=${d.id}`}
            className="inline-flex items-center min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold touch-manipulation">
            {d.repairs.length ? "Change the repair" : "Fix lines"}
          </Link>
        </div>
      </header>

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <h2 className="px-4 py-2.5 border-b border-ppp-charcoal-100 font-semibold text-ppp-charcoal text-[14px]">The conversation</h2>
        <ul className="divide-y divide-ppp-charcoal-100">
          {turns.map((t) => t.turn === null ? <ContextRow key={`m${t.position}`} t={t} /> : (
            <li key={`m${t.position}`} className="px-4 py-2">
              <span className="flex items-baseline gap-2">
                <span className="shrink-0 w-8 text-[11px] font-bold text-ppp-charcoal-400 tabular-nums">T{t.turn}</span>
                <span className="min-w-0 flex-1">
                  <span className="text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">
                    {t.label}
                    {(flagged.get(t.turn) ?? []).map((f, i) => (
                      <span key={i} className={[
                        "ml-1.5 normal-case tracking-normal rounded px-1",
                        f === "fixed" ? "bg-ppp-green-50 text-ppp-charcoal" : "bg-ppp-orange-50 text-ppp-orange-700",
                      ].join(" ")}>{f}</span>
                    ))}
                  </span>
                  <span className="block text-[12.5px] text-ppp-charcoal leading-snug whitespace-pre-wrap break-words">{t.text}</span>
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {d.findings.length > 0 && (
        <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3 space-y-2">
          <h2 className="font-semibold text-ppp-charcoal text-[14px]">Notes from the sheet</h2>
          {d.findings.map((f) => (
            <p key={f.id} className="text-[12.5px] text-ppp-charcoal-600 leading-relaxed">
              {f.turnOrdinal != null && <strong className="mr-1">T{f.turnOrdinal}</strong>}
              {f.code && <strong className="mr-1">{f.code}</strong>}
              {f.what}
              {f.shouldHave && <span className="block text-ppp-charcoal"><strong>Should have</strong> {f.shouldHave}</span>}
            </p>
          ))}
        </section>
      )}

      {d.repairs.map((r, n) => (
        <section key={r.id} className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-ppp-charcoal-100 flex items-center justify-between gap-2">
            <h2 className="font-semibold text-ppp-charcoal text-[14px]">
              Repair{d.repairs.length > 1 ? ` ${n + 1}` : ""}
            </h2>
            <span className={[
              "shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
              r.approved ? "bg-ppp-green-50 text-ppp-charcoal" : "bg-ppp-orange-50 text-ppp-orange-700",
            ].join(" ")}>
              {r.approved ? "Signed off, the bot copies this" : "Not signed off yet"}
            </span>
          </div>
          <ul className="divide-y divide-ppp-charcoal-100">
            {r.fixes.map((f) => (
              <li key={f.turn} className="px-4 py-2.5 space-y-1">
                <p className="text-[12px] text-ppp-charcoal-500">
                  <strong className="text-ppp-charcoal">T{f.turn}</strong>
                  {f.ruleIds.filter((x) => x.startsWith("code:")).map((x) => (
                    <strong key={x} className="ml-1.5 text-ppp-charcoal">{x.slice(5)}</strong>
                  ))}
                  {f.reason && <span className="ml-1.5">{f.reason}</span>}
                </p>
                <p className="text-[12.5px] text-ppp-charcoal leading-snug whitespace-pre-wrap">{f.replacement}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
