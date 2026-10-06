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
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendHumanReply } from "@/lib/messaging/reply-write";
import { listSnippetsFor } from "@/lib/messaging/snippet-write";
import type { ReadySnippet } from "@/lib/messaging/snippet-db";
import { smsSegments } from "@/lib/messaging/first-message";

const REFUSAL_LABEL: Record<string, string> = {
  suppressed: "This number has opted out, so nothing can be sent to it.",
  suppression_list_empty: "The opt-out list has not been imported yet, so sending is held.",
  quiet_hours: "It is outside this workspace's sending hours.",
  weekend: "This workspace does not send at weekends.",
  daily_cap: "This customer has already had the most messages we allow in a day.",
  no_workspace_number: "This workspace has no number to send from.",
  empty_body: "There is nothing to send.",
  /**
   * These three were reachable and unlabelled, so they rendered as
   * "Refused: unresolved_merge_field" — a sentence that tells somebody
   * mid-conversation with a customer nothing at all, and sends them looking
   * for a developer instead of for the problem.
   */
  unresolved_merge_field:
    "Part of this message was never filled in — look for something in {{double braces}} "
    + "and replace it with the real words.",
  too_long: "This is too long to send as one message. Shorten it or send it in two.",
  office_closed: "It is outside the hours PPP sends in, so this would not go out yet.",
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
  /**
   * The saved replies, ALREADY FILLED IN for this conversation.
   *
   * Loaded rather than passed as a prop because the filling needs the
   * customer's name and the workspace's number, which is the conversation's
   * business and not a text box's. What arrives here is the sentence that
   * will actually be sent — no {{customer_name}} for somebody to notice.
   */
  const [snippets, setSnippets] = useState<ReadySnippet[]>([]);
  /** The text of the last snippet inserted, while it is still undoable. */
  const [undoable, setUndoable] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    void (async () => {
      // A failure here loses the shortcut, never the reply box: a composer
      // that cannot list its snippets is a nuisance, one that will not render
      // is a customer nobody can answer.
      try {
        const list = await listSnippetsFor(conversationId);
        if (alive) setSnippets(list);
      } catch { /* the box still works */ }
    })();
    return () => { alive = false; };
  }, [conversationId]);

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
      /**
       * A THROW USED TO LEAVE NO TRACE, and the one thing an operator must
       * never be left guessing about is whether a customer got the text.
       *
       * This was the only one of the four composer-shaped forms with no
       * try/catch. A thrown action — a dropped connection, a server error —
       * left `problem` unset and the button back at "Send", which reads
       * exactly like a reply that was never attempted. The operator presses
       * again, and the customer gets it twice.
       *
       * The message says WHAT IS UNKNOWN rather than claiming failure,
       * because a throw between the carrier accepting and the row landing is
       * precisely the case where "it did not send" would be a lie.
       */
      try {
        const res = await sendHumanReply({ conversationId, body: trimmed });
        if (res.ok) {
          setBody("");
          setUndoable(null);
          router.refresh();
          return;
        }
        setProblem(res.refused ? (REFUSAL_LABEL[res.refused] ?? `Refused: ${res.refused}`) : (res.error ?? "It could not be sent."));
      } catch {
        setProblem(
          "Something went wrong and it is not clear whether that sent. "
          + "Check the thread before trying again, rather than pressing send twice."
        );
        router.refresh();
      }
    });
  };

  return (
    <section className="rounded-xl border border-ppp-charcoal-100 bg-white p-3 space-y-2">
      <label htmlFor="reply" className="block text-[12px] font-semibold text-ppp-charcoal">
        Reply to this customer
      </label>
      {/*
        SAVED REPLIES, ABOVE THE BOX.

        They were below it, between the textarea and Send — and they load
        asynchronously, so on a slow connection somebody types, reaches for
        Send, and the row appears under their thumb. The tap lands on a
        snippet and appends text they did not ask for. Above the box, a late
        arrival pushes the whole composer down rather than sliding a button
        under a finger already moving.

        Inserted, never sent: the rep still reads it, edits it and presses
        Send. That is why the content rules on a snippet are lighter than on a
        standing answer, and why Undo below matters more than a confirm.
      */}
      {snippets.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono uppercase tracking-wide text-ppp-charcoal-400">
              Saved replies
            </span>
            {/*
              UNDO, because a double tap used to be unrecoverable. Insert
              appends, so a second tap gives the same paragraph twice with no
              change of state to notice, and Ctrl+Z does not reverse a value
              React set programmatically. This removes exactly what was last
              inserted, and only while it is still the tail of the box.
            */}
            {undoable && (
              <button type="button" disabled={pending}
                onClick={() => { setBody((cur) => cur.slice(0, -undoable.length).trimEnd()); setUndoable(null); }}
                className="text-[11px] text-ppp-charcoal-500 underline underline-offset-2 disabled:opacity-40">
                Undo insert
              </button>
            )}
          </div>

          {/*
            Capped, because the row sits between what somebody types and the
            Send button. Hatch ships eleven named replies and Kate will want
            more; unbounded, fifteen is roughly nine rows on a phone and Send
            goes below the fold on every reply.
          */}
          <div className="flex flex-wrap gap-1.5">
            {(showAll ? snippets : snippets.slice(0, 6)).map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={pending}
                title={s.body}
                onClick={() => {
                  setBody((cur) => (cur.trim() ? `${cur.trimEnd()} ${s.body}` : s.body));
                  setUndoable(s.body);
                }}
                className="min-h-[44px] max-w-[15rem] px-3 py-1 rounded-lg border border-ppp-charcoal-200 bg-white text-left disabled:opacity-40 touch-manipulation"
              >
                <span className="block text-[12px] font-medium text-ppp-charcoal truncate">{s.name}</span>
                {/*
                  The first few words of the actual text. `title` is a native
                  tooltip and does not exist on touch at all, so on a phone the
                  name was the only thing anybody saw — and "Circling Back #1"
                  against "Circling Back #2" is a coin toss.
                */}
                <span className="block text-[11px] text-ppp-charcoal-400 truncate">{s.body}</span>
              </button>
            ))}
            {snippets.length > 6 && (
              <button type="button" onClick={() => setShowAll((v) => !v)}
                className="min-h-[44px] px-3 rounded-lg text-[12px] text-ppp-charcoal-500 underline underline-offset-2 touch-manipulation">
                {showAll ? "Show fewer" : `Show all ${snippets.length}`}
              </button>
            )}
          </div>
        </div>
      )}

      <textarea
        id="reply"
        value={body}
        onChange={(e) => {
          // Once they edit, the tail is no longer exactly what was inserted,
          // so an "undo" that sliced it off would cut their own words.
          if (undoable && !e.target.value.endsWith(undoable)) setUndoable(null);
          setBody(e.target.value);
        }}
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
