"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { sendDraft, rejectDraft } from "@/lib/messaging/drafts-write";
import { isStale, reviewReasonText, refusalText, wasEdited, type DraftForReview } from "@/lib/messaging/drafts";

type Msg = { direction: "inbound" | "outbound"; body: string; createdAt: string };

/**
 * One draft at a time, with the conversation above it.
 *
 * A list would be worse. Judging a reply needs the thread it belongs to, so a
 * list either shows the thread for every row — unreadable — or asks Kate to
 * decide from a fragment, which is how a reply that ignores what the customer
 * just said gets approved. One at a time also means the queue can order
 * itself: longest-waiting first, and anything stale ahead of that.
 *
 * The three actions are the three real answers: send it, send my version, or
 * do not send. "Save for later" is deliberately absent — a draft nobody
 * decides on is a customer nobody replies to.
 */
export default function DraftReview({
  drafts, thread, remaining,
}: {
  drafts: DraftForReview[];
  thread: Msg[];
  remaining: number;
}) {
  const router = useRouter();
  const draft = drafts[0];
  const [body, setBody] = useState(draft?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  if (!draft) {
    return (
      <div className="rounded-xl border border-ppp-charcoal-100 bg-white px-5 py-10 text-center">
        <p className="text-[14px] font-semibold text-ppp-charcoal">Nothing waiting</p>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed max-w-sm mx-auto">
          Every reply has been dealt with. New ones appear here as customers write in.
        </p>
      </div>
    );
  }

  const stale = isStale(draft);
  const edited = wasEdited(draft.body, body);

  const send = async () => {
    setBusy(true); setErr(null); setRefused(null);
    try {
      const res = await sendDraft({ draftId: draft.id, body });
      if (res.ok) { router.refresh(); return; }
      if ("refused" in res) setRefused(res.refused);
      else setErr(res.error);
    } catch {
      setErr("Could not send. Nothing was sent and the draft is still here.");
    } finally { setBusy(false); }
  };

  const reject = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await rejectDraft({ draftId: draft.id, reason: rejectReason });
      if (res.ok) { setRejecting(false); setRejectReason(""); router.refresh(); }
      else setErr(res.error);
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold text-ppp-charcoal text-[14px] truncate">
          {draft.customerName || draft.customerPhone}
        </h2>
        <span className="shrink-0 text-[12px] text-ppp-charcoal-500 tabular-nums">
          {remaining} waiting
        </span>
      </div>
      <p className="-mt-2 text-[12px] text-ppp-charcoal-500">{draft.workspaceName}</p>

      {/* The conversation, so the reply is judged against what was actually
          said rather than on its own. */}
      <section className="rounded-xl border border-ppp-charcoal-100 bg-ppp-charcoal-50 overflow-hidden">
        <div className="max-h-[45vh] overflow-y-auto px-3 py-3 space-y-2">
          {thread.length === 0 && (
            <p className="text-[12.5px] text-ppp-charcoal-500 text-center py-2">
              Nothing has been said yet. This would be the first message.
            </p>
          )}
          {thread.map((m, i) => (
            <div key={i} className={m.direction === "inbound" ? "flex" : "flex justify-end"}>
              <p className={[
                "max-w-[80%] rounded-2xl px-3 py-2 text-[13.5px] leading-snug whitespace-pre-wrap",
                m.direction === "inbound"
                  ? "bg-white border border-ppp-charcoal-100 text-ppp-charcoal"
                  : "bg-ppp-charcoal text-white",
              ].join(" ")}>
                {m.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {stale && (
        <section className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 px-4 py-3">
          <p className="text-[13px] font-semibold text-ppp-orange-700">They have written again since this was drafted</p>
          <p className="mt-1 text-[12.5px] text-ppp-orange-700/90 leading-relaxed">
            This answers an earlier message. Sending it as-is will read as though
            nobody looked at what they just said.
          </p>
        </section>
      )}

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
          <p className="text-[13px] font-semibold text-ppp-charcoal">What the bot wants to send</p>
          <p className="mt-0.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">
            {reviewReasonText(draft.reviewReason)}
            {draft.intent && (
              <> It is trying to <span className="font-mono text-[11px]">{draft.intent}</span>
              {draft.confidence !== null && <>, {Math.round(draft.confidence * 100)}% sure</>}.</>
            )}
          </p>
        </div>
        <div className="px-4 py-3">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            aria-label="The message that will be sent"
            className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-base sm:text-[14px] leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-ppp-charcoal-300"
          />
          {edited && (
            <p className="mt-1.5 text-[12px] text-ppp-charcoal-600">
              You have changed it. Your version is what gets sent, and the change
              is kept as an example of what it should have said.
            </p>
          )}
          {draft.reasoning && (
            <p className="mt-1.5 text-[11.5px] text-ppp-charcoal-400 leading-relaxed">
              Why it chose that: {draft.reasoning}
            </p>
          )}
        </div>
      </section>

      {refused && (
        <p className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 px-4 py-3 text-[12.5px] text-ppp-orange-700 leading-relaxed">
          {refusalText(refused)} It is still in the queue.
        </p>
      )}
      {err && (
        <p className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 px-4 py-3 text-[12.5px] text-ppp-orange-700">{err}</p>
      )}

      {!rejecting ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void send()} disabled={busy || !body.trim()}
            className="flex-1 min-w-[160px] min-h-[52px] px-4 rounded-xl bg-ppp-charcoal text-white text-[14px] font-semibold disabled:opacity-40 touch-manipulation">
            {busy ? "Sending…" : edited ? "Send my version" : "Send it"}
          </button>
          <button type="button" onClick={() => setRejecting(true)} disabled={busy}
            className="min-h-[52px] px-4 rounded-xl border border-ppp-charcoal-200 bg-white text-[14px] font-semibold text-ppp-charcoal-600 touch-manipulation">
            Don&apos;t send
          </button>
        </div>
      ) : (
        <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ppp-charcoal-600 mb-1">
              What was wrong with it? Optional, and the most useful thing you can leave.
            </span>
            <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={2}
              placeholder="It asked for the address again when we already had it"
              className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-base sm:text-[13px] resize-y" />
          </label>
          <div className="mt-2.5 flex gap-2">
            <button type="button" onClick={() => void reject()} disabled={busy}
              className="min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold touch-manipulation">
              {busy ? "Saving…" : "Don't send it"}
            </button>
            <button type="button" onClick={() => setRejecting(false)} disabled={busy}
              className="min-h-[44px] px-4 rounded-xl border border-ppp-charcoal-200 bg-white text-[13px] font-semibold text-ppp-charcoal touch-manipulation">
              Back
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
