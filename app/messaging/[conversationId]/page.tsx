import Link from "next/link";
import { notFound } from "next/navigation";
import { loadThread } from "@/lib/messaging/db";
import { formatUs, type E164 } from "@/lib/messaging/phone";

export const dynamic = "force-dynamic";

const OUTCOME_LABEL: Record<string, string> = {
  success: "Booked", discard: "Discarded", schedule_follow_up: "Follow-up scheduled",
  lost: "Lost", bailout: "Bailed out", phone_pricing: "Phone pricing",
  transferred: "Transferred", bot_suspected: "Bot suspected",
  msg_liked_loved: "Reaction", area_not_serviced: "Area not serviced",
};

function when(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export default async function Thread({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  const data = await loadThread(conversationId);
  if (!data) notFound();
  const { conversation: c, messages } = data;
  const ended = c.state === "ended";

  return (
    // pb-40 clears the fixed composer. Without it the last message sits under
    // the input and the newest thing in the thread is the thing you cannot read.
    <main className="max-w-3xl mx-auto px-4 py-3 pb-40">
      <Link
        href="/messaging"
        className="inline-flex items-center gap-1.5 min-h-[44px] -ml-1 px-1 text-[13px] font-medium text-ppp-charcoal-500 hover:text-ppp-charcoal touch-manipulation"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M19 12H5 M12 19l-7-7 7-7" />
        </svg>
        Inbox
      </Link>

      <header className="mt-1 mb-4">
        <h1 className="text-xl font-bold text-ppp-charcoal truncate">
          {c.customer_name || formatUs(c.customer_phone as E164)}
        </h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ppp-charcoal-500">
          <span>{c.workspace_name}</span>
          <span className="text-ppp-charcoal-300">·</span>
          <span className="font-mono">{formatUs(c.customer_phone as E164)}</span>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <span className={[
            "inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold",
            ended ? "bg-ppp-charcoal-100 text-ppp-charcoal-600"
                  : c.state === "human_active" ? "bg-ppp-orange-50 text-ppp-orange-700"
                  : "bg-ppp-green-50 text-ppp-green-700",
          ].join(" ")}>
            {ended ? (OUTCOME_LABEL[c.outcome ?? ""] ?? c.outcome) : c.state === "human_active" ? "You have it" : "AI working"}
          </span>
          {c.owning_agent && !ended && (
            <span className="inline-flex items-center rounded-full bg-white border border-ppp-charcoal-200 px-2.5 py-1 text-[11px] text-ppp-charcoal-600">
              {c.owning_agent}
            </span>
          )}
          {/* Why this send is lawful, surfaced rather than buried. The lead
              agents and the post-job agents do not stand on the same ground. */}
          <span className="inline-flex items-center rounded-full bg-white border border-ppp-charcoal-200 px-2.5 py-1 text-[11px] text-ppp-charcoal-500">
            {c.consent_basis === "inquiry" ? "They contacted PPP" : "Existing customer"}
          </span>
        </div>
      </header>

      {messages.length === 0 ? (
        <p className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-6 text-center text-[13px] text-ppp-charcoal-500">
          No messages yet.
        </p>
      ) : (
        <ol className="space-y-2.5">
          {messages.map((m) => {
            const out = m.direction === "outbound";
            return (
              <li key={m.id} className={out ? "flex justify-end" : "flex justify-start"}>
                {/* 85% keeps a long message from spanning edge to edge, which is
                    what makes the direction readable at a glance on a phone. */}
                <div className={[
                  "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed",
                  out ? "bg-ppp-charcoal text-white rounded-br-md"
                      : "bg-white border border-ppp-charcoal-100 text-ppp-charcoal rounded-bl-md",
                ].join(" ")}>
                  {m.subject && <p className="font-semibold mb-1">{m.subject}</p>}
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  <p className={`mt-1.5 text-[10px] font-mono ${out ? "text-white/60" : "text-ppp-charcoal-400"}`}>
                    {when(m.created_at)}
                    {m.sent_by_agent ? ` · ${m.sent_by_agent}` : ""}
                    {m.channel === "email" ? " · email" : ""}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {/* Fixed composer. Sending is off platform-wide, so it says so rather
          than presenting a control that silently does nothing — a disabled
          button with no reason is worse than no button. */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-ppp-charcoal-100 px-4 pt-3 pb-safe">
        <div className="max-w-3xl mx-auto">
          <textarea
            rows={2}
            disabled
            placeholder="Sending is switched off until the carrier is connected"
            className="w-full resize-none rounded-xl border border-ppp-charcoal-200 bg-ppp-charcoal-50 px-3 py-2.5 text-base sm:text-[14px] text-ppp-charcoal placeholder:text-ppp-charcoal-400 disabled:cursor-not-allowed"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-[11px] text-ppp-charcoal-500 leading-tight">
              Shadow mode — drafts are recorded, nothing is delivered.
            </p>
            <button
              type="button"
              disabled
              className="shrink-0 min-h-[44px] px-4 rounded-xl bg-ppp-charcoal-200 text-ppp-charcoal-500 text-[13px] font-semibold cursor-not-allowed"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
