import Link from "next/link";
import DraftReview from "@/components/messaging/draft-review";
import { pendingDrafts, draftThread } from "@/lib/messaging/drafts-write";
import { transportChoice } from "@/lib/messaging/transport-config";

export const dynamic = "force-dynamic";

/**
 * The screen that makes "test it before we message real people" possible.
 *
 * Autosend is off everywhere, so every reply the agent writes waits here. That
 * is the whole safety model for the first weeks: the bot proposes, a person
 * decides, and nothing reaches a customer without somebody having read it.
 */
export default async function DraftReviewPage() {
  const drafts = await pendingDrafts();
  const thread = drafts[0] ? await draftThread(drafts[0].conversationId) : [];
  const transport = transportChoice();

  return (
    <main className="max-w-2xl mx-auto px-4 py-4 pb-safe space-y-4">
      <header>
        <h1 className="font-bold text-ppp-charcoal">Replies to approve</h1>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          The bot writes, you decide. Nothing reaches a customer until you send it.
        </p>
      </header>

      {!transport.live && (
        <section className="rounded-xl border border-ppp-charcoal-200 bg-ppp-charcoal-50 px-4 py-3">
          <p className="text-[13px] font-semibold text-ppp-charcoal">Nothing is being delivered yet</p>
          <p className="mt-1 text-[12.5px] text-ppp-charcoal-600 leading-relaxed">
            {transport.why} Approving still records the decision and writes the
            message into the thread, so the whole flow can be tested exactly as
            it will run.
          </p>
        </section>
      )}

      <DraftReview drafts={drafts} thread={thread} remaining={drafts.length} />

      <p className="text-[12px] text-ppp-charcoal-500 leading-relaxed">
        Approving does not override the send gate. Someone who has opted out,
        quiet hours, the weekend rule and the daily cap all still apply — if one
        of them refuses, the reply stays here and says which.{" "}
        <Link href="/messaging/settings" className="underline">Hours live in settings</Link>.
      </p>
    </main>
  );
}
