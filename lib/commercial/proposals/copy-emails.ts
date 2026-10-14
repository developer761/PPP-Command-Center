import "server-only";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Internal copies on every proposal email that reaches a GC (Karan 2026-08-04).
 * These addresses become the Reply-To (so the GC's reply reaches Brendan + the
 * ops inbox, not a generic company address) AND a silent BCC (so they always
 * have a copy of what went out). Brendan runs proposal approvals, so replies
 * should land with him. Overridable via env (comma-separated) without a deploy.
 *
 * Shared by the proposal send and the e-signature emails — a signed contract
 * the office never received a copy of is worse than the proposal itself going
 * uncopied.
 */
export const PROPOSAL_COPY_EMAILS = parseList(
  process.env.COMMERCIAL_PROPOSAL_COPY_EMAILS ||
    "brendan@tomcopainting.com,developer@precisionpaintingplus.net",
);

/**
 * The office, copied so they know a proposal went out — and NOTHING else.
 *
 * Stephanie 2026-10-14: *"Is there a way to have everyone cc'd when a proposal
 * does go out from Command? Me, Kim, Brendan, and Mary just so we can stay on
 * top of the goings on?"*
 *
 * WHY THIS IS A SECOND LIST INSTEAD OF MORE ADDRESSES IN THE FIRST ONE
 *
 * `PROPOSAL_COPY_EMAILS` does two jobs at once: it is the BCC *and* the
 * Reply-To. Adding three more people to it would have copied them in, which is
 * what was asked — and also made every GC reply land in four extra inboxes,
 * which was not. Replies belong with Brendan, who runs proposal approvals;
 * watchers want to see what went out, not to field the answer.
 *
 * So this list is BCC-only. Reply-To is untouched.
 *
 * BCC rather than a visible CC on purpose: a real CC would put four internal
 * addresses on the GC's copy and invite a reply-all that reaches the whole
 * office. Each watcher still receives their own copy — which is what "stay on
 * top of the goings on" needs. Say the word if the visible CC is genuinely
 * wanted; it is a one-line change from here.
 */
export const PROPOSAL_NOTIFY_EMAILS = parseList(
  process.env.COMMERCIAL_PROPOSAL_NOTIFY_EMAILS || "",
);

/**
 * Everyone who gets a silent copy of a proposal or a signature email: the
 * reply-to list plus the watchers, de-duplicated.
 *
 * De-duplication matters because Brendan is on both lists by description — he
 * approves proposals AND is one of the four Stephanie named — and a duplicate
 * address in a BCC header is how a provider decides to send two copies.
 *
 * Callers still have to drop the visible To/Cc themselves; this function does
 * not know who they are.
 */
export function proposalBccList(): string[] {
  return [...new Set([...PROPOSAL_COPY_EMAILS, ...PROPOSAL_NOTIFY_EMAILS])];
}

function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => EMAIL_RE.test(e));
}
