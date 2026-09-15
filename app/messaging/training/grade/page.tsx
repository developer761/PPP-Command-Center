import Link from "next/link";
import Grader from "@/components/messaging/grader";
import { nextToGrade, gradeItem } from "@/lib/messaging/grading";
import { ruleOptions } from "@/lib/messaging/repair-write";

export const dynamic = "force-dynamic";

/** `?id=` opens one conversation, which is how Rated conversations re-grades. */
export default async function GradePage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;
  const [queue, options, picked] = await Promise.all([
    nextToGrade(), ruleOptions(), id ? gradeItem(id) : Promise.resolve(null),
  ]);

  return (
    <main className="max-w-3xl mx-auto px-4 py-4 pb-safe space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Link href="/messaging/training"
          className="inline-flex items-center gap-1.5 min-h-[44px] -ml-1 px-1 text-[13px] font-medium text-ppp-charcoal-500 hover:text-ppp-charcoal touch-manipulation">
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
        <h1 className="text-lg font-bold text-ppp-charcoal">Grade conversations</h1>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          Read one, say how it was handled, and pick which rules it shows. The
          rules are what make it useful. A grade on its own teaches nothing.
        </p>
      </header>
      <Grader
        key={picked?.id ?? "queue"}
        first={picked ?? queue.item}
        remaining={queue.remaining}
        options={options}
      />
    </main>
  );
}
