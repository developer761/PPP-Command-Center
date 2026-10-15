/**
 * WHAT THE VENDOR WROTE, SEPARATED FROM WHAT THEY REPLIED TO.
 *
 * An email reply is two documents in one body: a sentence or two of new
 * information, and underneath it the entire message being answered. Kate's
 * 2026-10-14 reply is nine words followed by sixty lines of the order we had
 * just sent her — our own paint list, quoted back at us.
 *
 * Both surfaces that show a reply need the same cut:
 *
 *   - the bell + email preview, which must not read "Confirmed — On Wed, Oct
 *     14 Precision Painting Plus wrote: Hi there, Please prepare…";
 *   - the Mail Hub thread, which should open on the nine words rather than
 *     making somebody scroll the order to find them.
 *
 * So the cut lives here once, and neither copy can drift from the other.
 *
 * ── WHY IT CUTS RATHER THAN FILTERS ─────────────────────────────────────
 *
 * The first version dropped any line that looked like an attribution and kept
 * reading. That failed twice over on the first real message: a genuine
 * attribution with an address in it is longer than the 80 characters the
 * filter allowed, and Gmail wraps the line anyway, so the "wrote:" it
 * anchored on is routinely not on the same line as the "On".
 *
 * Everything below an attribution is quoted history. The honest operation is
 * to stop there, not to drop one line and carry on.
 *
 * ── THE REPLY CAN BE EMPTY, AND THAT IS NOT A FAILURE ────────────────────
 *
 * Someone who bottom-posts, or who answers inline inside the quote, leaves
 * nothing above the attribution. `reply` comes back empty and `quoted` holds
 * the message. Callers decide what that means: the preview has nothing to
 * show, while the thread view shows the whole body uncollapsed — hiding an
 * entire message behind a "show quoted text" toggle would be worse than the
 * clutter it was meant to fix.
 */

/**
 * The first marker of quoted history.
 *
 * Three shapes, in the order they turn up here: Gmail/Apple Mail's "On <date>
 * <person> wrote:" (allowed to run across lines, because it wraps), Outlook's
 * "-----Original Message-----", and the long underscore rule some clients draw
 * instead.
 *
 * The `wrote:` is required, which is what keeps the cut off ordinary prose —
 * "On Friday we can deliver the Revere Pewter" is a reply, not a header.
 *
 * ── THE "On" MUST START A LINE ──────────────────────────────────────────
 *
 * It did not, and Kate found it the same afternoon (FU.13, 2026-10-15). The
 * newline was optional — `\n?\s*On\s` — so with the `i` flag the pattern
 * matched the "on " inside a WORD. Her vendor reply read
 *
 *     Hitting "Reply All" as a test -- I'm the vendor, k.sutton is the sender
 *
 * and the hub showed `...I'm the vendor, k.sutt`, a "Show quoted text"
 * button, and `on is the sender` folded away behind it. The cut landed in
 * the middle of her name, and the rest of her sentence was filed as someone
 * else's quoted email.
 *
 * Every test I wrote put the attribution at the start of a line, so the
 * suite was green on a rule that could fire anywhere in a sentence.
 *
 * A real attribution is always at the start of a line, optionally behind
 * some `>` quote markers. Anchoring there costs nothing and makes a
 * mid-word match impossible.
 */
const QUOTE_MARKER =
  /(?:^|\n)[ \t]*>*[ \t]*On\s[\s\S]{0,200}?wrote:|\n\s*-{2,}\s*Original Message\s*-{2,}|\n\s*_{5,}/i;

export type SplitReply = {
  /** What this person wrote. Empty when they wrote below the quote. */
  reply: string;
  /** The thread they were answering, attribution line included. */
  quoted: string;
};

export function splitQuotedReply(bodyText: string | null | undefined): SplitReply {
  const raw = (bodyText ?? "").replace(/\r\n/g, "\n");
  const cutAt = raw.search(QUOTE_MARKER);
  if (cutAt < 0) return { reply: raw, quoted: "" };
  return { reply: raw.slice(0, cutAt), quoted: raw.slice(cutAt) };
}
