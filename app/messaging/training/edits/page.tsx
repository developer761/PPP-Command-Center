import Link from "next/link";
import { draftEdits } from "@/lib/messaging/draft-edits";

export const dynamic = "force-dynamic";

/**
 * WHAT A REVIEWER CHANGED, which nothing could read until 2026-10-06.
 *
 * Migration 198: "THE EDIT IS THE POINT. final_body is kept separately from
 * body rather than overwriting it, because the difference between what the
 * agent wrote and what the human sent is the most valuable training signal
 * this system can produce."
 *
 * It was written by sendDraft and read by nothing — one writer, one test, no
 * application reader anywhere. The same for reject_reason, which the review
 * screen asks for under "the most useful thing you can leave". Both were
 * accumulating in columns nobody had ever looked at.
 *
 * This screen is only the reading. It takes no action and changes nothing: a
 * person looks at what the bot wrote beside what somebody actually sent, and
 * decides what it is worth. That is the same act the repair console performs
 * on an older conversation, which is why this sits beside it rather than
 * inventing a new workflow.
 */
export default async function EditsPage() {
  const edits = await draftEdits();

  return (
    <main className="max-w-3xl mx-auto px-4 py-4 pb-safe space-y-4">
      <Link href="/messaging/training" className="text-[12.5px] text-ppp-charcoal-500 underline">
        ← Training
      </Link>

      <header>
        <h1 className="text-lg font-bold text-ppp-charcoal">What you changed</h1>
        <p className="mt-1 text-[13px] text-ppp-charcoal-600 leading-relaxed">
          Every reply somebody rewrote before sending, and every one they binned.
          The difference between what the bot wrote and what you actually sent is
          the most useful thing this system can learn from, and it is written
          down as a by-product of you doing the job.
        </p>
      </header>

      {edits.length === 0 ? (
        <div className="rounded-xl border border-ppp-charcoal-100 bg-white px-5 py-10 text-center">
          <p className="text-[14px] font-semibold text-ppp-charcoal">Nothing yet</p>
          <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
            This fills up on its own. Rewrite a reply before sending it, or bin
            one and say why, and it appears here.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {edits.map((e) => (
            <li key={e.id} className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-ppp-charcoal-100">
                <span className={[
                  "rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
                  e.kind === "rejected"
                    ? "bg-ppp-orange-50 text-ppp-orange-700"
                    : "bg-ppp-charcoal-50 text-ppp-charcoal-600",
                ].join(" ")}>
                  {e.kind === "rejected" ? "Binned" : "Rewritten"}
                </span>
                {e.intent && (
                  <span className="rounded-full bg-ppp-charcoal-50 px-2 py-0.5 text-[10px] font-mono text-ppp-charcoal-500">
                    {e.intent}
                  </span>
                )}
                {e.confidence !== null && (
                  <span className="text-[10.5px] tabular-nums text-ppp-charcoal-400">
                    {Math.round(e.confidence * 100)}%
                  </span>
                )}
                <Link href={`/messaging/${e.conversationId}`}
                  className="ml-auto text-[11.5px] text-ppp-charcoal-500 underline">
                  the thread
                </Link>
              </div>

              <div className="px-4 py-3 space-y-2.5">
                <div>
                  <p className="text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">
                    The bot wrote
                  </p>
                  <p className="mt-0.5 text-[13px] text-ppp-charcoal-600 leading-relaxed">{e.botWrote}</p>
                </div>

                {e.humanSent && (
                  <div>
                    <p className="text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">
                      You sent
                    </p>
                    <p className="mt-0.5 text-[13px] font-medium text-ppp-charcoal leading-relaxed">{e.humanSent}</p>
                  </div>
                )}

                {e.why && (
                  <div>
                    <p className="text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">
                      Why
                    </p>
                    <p className="mt-0.5 text-[13px] text-ppp-charcoal-600 leading-relaxed">{e.why}</p>
                  </div>
                )}

                {/* A rejection with no reason is the one shape worth naming,
                    because it is the one that teaches nothing. */}
                {e.kind === "rejected" && !e.why && (
                  <p className="text-[11.5px] text-ppp-charcoal-400">
                    Binned without a reason, so there is nothing here to learn from.
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
