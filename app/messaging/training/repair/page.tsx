import Link from "next/link";
import RepairConsole from "@/components/messaging/repair-console";
import { repairQueue } from "@/lib/messaging/repair-write";
import { activeTags } from "@/lib/messaging/authoring";

export const dynamic = "force-dynamic";

/**
 * Karan's idea: use the conversations that nearly went right, and the
 * corrections attached to them, to build ones that did.
 *
 * The corpus has four good examples out of fifty-two, so the bot is far better
 * at knowing what to avoid than what to do. Every "mid" conversation carries
 * an explicit correction, which makes each one a good conversation with a
 * single line wrong.
 */
export default async function RepairPage() {
  const [candidates, tags] = await Promise.all([repairQueue(), activeTags()]);

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
        <h1 className="text-lg font-bold text-ppp-charcoal">Fix a near-miss</h1>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          These conversations nearly went right, and Kate wrote down exactly
          what should have happened instead. Rewrite the one line that was wrong
          and it becomes an example of the thing done properly.
        </p>
      </header>

      <RepairConsole
        candidates={candidates}
        tags={tags.map((t) => ({ key: t.key, label: t.label }))}
      />

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3">
        <h2 className="font-semibold text-ppp-charcoal text-[14px]">What a repair is, and is not</h2>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          A repair is written, not received. It is built from a real
          conversation, so it reads like one — but the customer never saw the
          fixed line. It is stored as a repair for ever, it always points back
          at the conversation it came from, and the database refuses to create
          one already signed off. Somebody has to read the whole thing first,
          because a corpus of unread repairs would teach the bot our guesses
          about good rather than PPP&apos;s actual standard.
        </p>
      </section>
    </main>
  );
}
