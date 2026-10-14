/**
 * One way to turn a human-written list of addresses into recipients.
 *
 * WHY THIS IS SHARED RATHER THAN RE-WRITTEN PER SENDER
 *
 * On 2026-10-14 an audit found four recipient builders, each doing a different
 * subset of the same four jobs, and each missing a different one:
 *
 *   opsAlertRecipients       split · lower · validate · ✗ no de-dup
 *   receivablesRecipients    split ·   ✗   ·    ✗     · ✗ no de-dup
 *   reportRecipients         split ·   ✗   · validate · ✗ no de-dup
 *   parseList (proposals)    split · lower · validate · de-dup
 *
 * Each omission is its own bug. No de-dup plus lowercasing MANUFACTURES a
 * duplicate from "Kate@x.com, kate@x.com" — two copies of the alert, from an
 * env var that contains no visible repeat. No validation is worse: Resend
 * rejects the WHOLE send on one bad address, so `"alex@x.com, not-an-email"`
 * delivers to nobody, which is how a daily report goes quiet without an error
 * anybody reads.
 *
 * So all four now call this. The next sender gets it right by default instead
 * of by remembering.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not throw, and it does not report what it dropped. A recipient list
 * is nearly always configuration, and a mailer that dies because somebody left
 * a trailing comma in a Vercel setting is worse than one that mails everybody
 * who is actually addressable. Callers that need to tell a person about a typo
 * — a form, say — must validate before calling, the way the proposal send sheet
 * does, so they can name the bad address instead of silently dropping it.
 */

/**
 * Deliberately the same shape used across the app, not a stricter one. It is a
 * sanity check against fragments and pasted prose, not an RFC 5322 parser —
 * the mail provider is the real authority on deliverability, and a regex
 * tight enough to reject a valid oddity would be a worse failure than letting
 * the provider bounce it.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Split on every separator these lists actually arrive with — commas,
 * semicolons, newlines and bare spaces — because they are pasted out of
 * Outlook, out of Slack, and typed into textareas.
 *
 * Lower-cased so that "Kim@x.com" and "kim@x.com" are one person, which is
 * what makes the de-dup work at all. Order is preserved: the first spelling of
 * an address wins, so a list stays in the order somebody wrote it.
 */
export function parseRecipients(raw: string | null | undefined): string[] {
  return [
    ...new Set(
      String(raw ?? "")
        .split(/[,;\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => EMAIL_RE.test(s)),
    ),
  ];
}

/**
 * Drop anyone who can already SEE the message from a list of silent copies.
 *
 * `visible` is `string[]`, never a joined string — see `dropVisible` in
 * `lib/commercial/proposals/copy-emails.ts` for the bug that makes the type
 * matter: a BCC filtered against a comma-joined display string never matches
 * once there are two CCs, and the same person ends up in cc AND bcc.
 */
export function withoutVisible(bcc: string[], ...visible: string[][]): string[] {
  const seen = new Set(visible.flat().map((e) => e.trim().toLowerCase()));
  return bcc.filter((e) => !seen.has(e.trim().toLowerCase()));
}
