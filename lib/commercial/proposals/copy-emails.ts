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
 * top of the goings on" needs.
 *
 * WHY IT LIVES IN THE DATABASE AND NOT IN THE ENVIRONMENT
 *
 * Karan 2026-10-14: *"How can they add it themselves?"* An env var is a
 * standing request to a contractor every time somebody joins or leaves the
 * office, which is the kind of setting that quietly goes stale. So the list is
 * `commercial_settings.proposal_notify_emails`, editable on
 * Settings → Notifications by an admin, and the env var remains only as a
 * bootstrap/override for a deploy that has no database write yet.
 */
export const SETTING_PROPOSAL_NOTIFY = "proposal_notify_emails";

/**
 * Deliberately NOT `getCommercialSetting` — that helper caches for an hour per
 * server instance, so Stephanie adding Mary and watching the next proposal go
 * out without her would look exactly like a bug. Proposals go out a handful of
 * times a week; a fresh read costs nothing and means the setting is true the
 * moment it is saved.
 */
export async function getProposalNotifyEmails(): Promise<string[]> {
  const envList = parseList(process.env.COMMERCIAL_PROPOSAL_NOTIFY_EMAILS || "");
  try {
    const { commercialDb } = await import("@/lib/commercial/db");
    const { data, error } = await commercialDb()
      .from("commercial_settings")
      .select("value")
      .eq("key", SETTING_PROPOSAL_NOTIFY)
      .maybeSingle();
    if (error) throw new Error(error.message);
    // No row yet → fall back to the env var. An EMPTY SAVED LIST is a real
    // answer ("nobody") and must not fall back, or removing the last watcher
    // would silently restore whatever the environment still holds.
    if (!data) return envList;
    const saved = data.value;
    return parseList(Array.isArray(saved) ? saved.join(",") : String(saved ?? ""));
  } catch (err) {
    // A settings read must never stop a proposal reaching its GC. Fall back to
    // the environment and say so, rather than throwing inside the mailer.
    console.warn(
      "[proposals/copy-emails] could not read the watcher list, using env:",
      err instanceof Error ? err.message : err,
    );
    return envList;
  }
}

/** Save the watcher list. Returns what was stored, after validation. */
export async function setProposalNotifyEmails(
  raw: string,
  userId?: string | null,
): Promise<string[]> {
  const list = parseList(raw);
  const { setCommercialSetting } = await import("@/lib/commercial/settings");
  await setCommercialSetting(SETTING_PROPOSAL_NOTIFY, list, userId ?? null);
  return list;
}

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
export async function proposalBccList(): Promise<string[]> {
  return [...new Set([...PROPOSAL_COPY_EMAILS, ...(await getProposalNotifyEmails())])];
}

/**
 * Which of the silent copies survive, once the people who can already SEE the
 * message are removed.
 *
 * 🔴 THE SIGNATURE IS THE POINT. `visible` is `string[]`, never a string.
 *
 * `proposals/email.ts` keeps two things: `ccList` (the addresses) and `ccEmail`
 * (those addresses joined with ", " for the audit note and the `cc_email`
 * column). It filtered the BCC with `e !== ccEmail` — comparing ONE address
 * against the whole joined string, which is always true as soon as there are
 * two CCs. Anyone both CC'd and on the copy list stayed in `cc` AND `bcc`, and
 * a repeated address is how a provider decides to send two copies. Brendan is
 * CC'd on proposals by convention and is on the copy list, so it duplicated him
 * with no watchers configured at all.
 *
 * It read fine for a year because CC was a single box, so the comparison
 * worked by accident until multi-CC landed (Stephanie, 2026-10-08).
 *
 * `cc` is typed `string[]` and NOT `string | string[]`, deliberately. A
 * permissive signature would still accept `ccEmail` and leave the bug
 * reachable — the first version of this function did exactly that, and the
 * "tsc now refuses it" claim was false until the type was narrowed. Now
 * `dropVisible(list, to, ccEmail)` fails to compile.
 */
export function dropVisible(bcc: string[], to: string | null, cc: string[]): string[] {
  const norm = (e: string) => e.trim().toLowerCase();
  const seen = new Set([...(to ? [to] : []), ...cc].filter(Boolean).map(norm));
  return bcc.filter((e) => !seen.has(norm(e)));
}

/**
 * Split the way addresses actually arrive — commas, semicolons, newlines or
 * plain spaces, because they get pasted out of Outlook and out of Slack.
 * Invalid fragments are dropped rather than passed to the mailer: one typo in a
 * settings box must not stop a proposal reaching a GC.
 */
export function parseList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,;\s]+/)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => EMAIL_RE.test(e)),
    ),
  ];
}
