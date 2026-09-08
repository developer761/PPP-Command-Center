import Link from "next/link";
import Grader from "@/components/messaging/grader";
import { nextToGrade } from "@/lib/messaging/grading";
import { messagingDb } from "@/lib/messaging/db";

export const dynamic = "force-dynamic";

export default async function GradePage() {
  const sb = messagingDb();
  const [{ item, remaining }, { data: tags }] = await Promise.all([
    nextToGrade(),
    sb.from("sms_training_tags").select("key, section, label, what_to_look_for").eq("is_active", true).order("sort_order"),
  ]);

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
        <h1 className="text-lg font-bold text-ppp-charcoal">Grade conversations</h1>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          Read one, say how it was handled, and tick which of Emily&apos;s rules
          it shows. The rules are what make it useful — a grade on its own
          teaches nothing.
        </p>
      </header>
      <Grader first={item} remaining={remaining} tags={tags ?? []} />
    </main>
  );
}
