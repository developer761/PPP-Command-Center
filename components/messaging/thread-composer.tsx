"use client";

/**
 * Replying to a customer, as a person.
 *
 * Until this existed, taking a conversation over left nobody able to answer it:
 * the bot stops by design, campaign steps wait, and the only other way to reach
 * a customer was approving a draft the bot may never have written. The handoff
 * bar invited Kate to claim a thread and told her "the bot stops replying",
 * which was true, and then offered her nothing to type into.
 *
 * Shows what the gate will actually send, not what was typed. The gate appends
 * the opt-out line to a first message, and a composer that hides that is a
 * composer that lies about the message length and the segment count.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendHumanReply } from "@/lib/messaging/reply-write";
import { smsSegments } from "@/lib/messaging/first-message";

const REFUSAL_LABEL: Record<string, string> = {
  suppressed: "This number has opted out, so nothing can be sent to it.",
  suppression_list_empty: "The opt-out list has not been imported yet, so sending is held.",
  quiet_hours: "It is outside this workspace's sending hours.",
  weekend: "This workspace does not send at weekends.",
  daily_cap: "This customer has already had the most messages we allow in a day.",
  no_workspace_number: "This workspace has no number to send from.",
  empty_body: "There is nothing to send.",
};

export function ThreadComposer({ conversationId, ended, heldByOther, holderName }: {
  conversationId: string;
  ended: boolean;
  heldByOther: boolean;
  holderName: string | null;
}) {
  const [body, setBody] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  if (ended) {
    return (
      <p className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3 text-[12.5px] text-ppp-charcoal-500">
        This conversation has ended, so it cannot be replied to.
      </p>
    );
  }

  if (heldByOther) {
    return (
      <p className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3 text-[12.5px] text-ppp-charcoal-500">
        {holderName ?? "Somebody else"} has taken this conversation over, so it is theirs to answer.
      </p>
    );
  }

  const trimmed = body.trim();
  const segments = trimmed ? smsSegments(trimmed) : 0;

  const send = () => {
    setProblem(null);
    start(async () => {
      const res = await sendHumanReply({ conversationId, body: trimmed });
      if (res.ok) {
        setBody("");
        router.refresh();
        return;
      }
      setProblem(res.refused ? (REFUSAL_LABEL[res.refused] ?? `Refused: ${res.refused}`) : (res.error ?? "It could not be sent."));
    });
  };

  return (
    <section className="rounded-xl border border-ppp-charcoal-100 bg-white p-3 space-y-2">
      <label htmlFor="reply" className="block text-[12px] font-semibold text-ppp-charcoal">
        Reply to this customer
      </label>
      <textarea
        id="reply"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        disabled={pending}
        placeholder="Type the message you want to send…"
        className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-[16px] leading-relaxed text-ppp-charcoal focus:outline-none focus:ring-2 focus:ring-ppp-charcoal/20 disabled:opacity-60"
      />

      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-mono text-ppp-charcoal-400">
          {trimmed.length} characters
          {segments > 0 && ` · ${segments} text${segments === 1 ? "" : "s"}`}
        </p>
        <button
          type="button"
          onClick={send}
          disabled={pending || !trimmed}
          className="min-h-[44px] px-4 rounded-lg bg-ppp-charcoal text-white text-[13px] font-medium disabled:opacity-40 touch-manipulation"
        >
          {pending ? "Sending…" : "Send"}
        </button>
      </div>

      {problem && (
        <p className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 px-3 py-2 text-[12.5px] text-ppp-orange-700">
          {problem}
        </p>
      )}

      <p className="text-[11px] text-ppp-charcoal-400 leading-relaxed">
        Goes through the same checks as everything else — the opt-out list, the
        daily cap and this workspace&apos;s hours all still apply.
      </p>
    </section>
  );
}
