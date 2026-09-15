import Link from "next/link";
import RepairConsole from "@/components/messaging/repair-console";
import { repairQueue, repairCandidate, ruleOptions } from "@/lib/messaging/repair-write";

export const dynamic = "force-dynamic";

/**
 * Karan's idea: use the conversations that nearly went right, and the
 * corrections attached to them, to build ones that did.
 *
 * `?example=` opens one conversation first, which is how Rated conversations
 * sends somebody back to a repair they want to change.
 */
export default async function RepairPage({
  searchParams,
}: {
  searchParams: Promise<{ example?: string }>;
}) {
  const { example } = await searchParams;
  const [queue, options, picked] = await Promise.all([
    repairQueue(100), ruleOptions(), example ? repairCandidate(example) : Promise.resolve(null),
  ]);
  const candidates = picked
    ? [picked, ...queue.filter((c) => c.exampleId !== picked.exampleId)]
    : queue;

  return (
    <main className="max-w-3xl mx-auto px-4 py-4 pb-safe space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Link href="/messaging/training"
          className="inline-flex items-center gap-1.5 min-h-[44px] -ml-1 px-1 text-[13px] font-medium text-ppp-charcoal-500 touch-manipulation">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5 M12 19l-7-7 7-7" />
          </svg>
          Training
        </Link>
        <Link href="/messaging/training/rated"
          className="inline-flex items-center min-h-[44px] px-1 text-[13px] font-medium text-ppp-charcoal-600 underline underline-offset-2 touch-manipulation">
          Rated conversations
        </Link>
      </div>

      <header>
        <h1 className="text-lg font-bold text-ppp-charcoal">Fix a near-miss</h1>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          Rewrite every line Emily got wrong, and the conversation becomes an
          example of the thing done properly. One repair can fix as many lines
          as it needs.
        </p>
      </header>

      {example && !picked && (
        <p className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 px-3 py-2 text-[12.5px] text-ppp-orange-700">
          That conversation could not be found, so the queue starts from the top.
        </p>
      )}

      <RepairConsole candidates={candidates} options={options} />

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3">
        <h2 className="font-semibold text-ppp-charcoal text-[14px]">What a repair is, and is not</h2>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          A repair is written, not received. It is built from a real
          conversation, so it reads like one, but the customer never saw the
          fixed lines. It always points back at the conversation it came from,
          and the database refuses one that starts signed off or stays signed
          off after its text changes. Somebody has to read the whole thing,
          because a corpus of unread repairs would teach the bot our guesses
          about good rather than PPP&apos;s actual standard.
        </p>
      </section>
    </main>
  );
}
