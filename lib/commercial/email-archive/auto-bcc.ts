import "server-only";

import { buildArchiveAddress } from "./address";

/**
 * File everything we send to a GC into that job's email archive, without
 * anybody remembering to.
 *
 * Karan, 2026-09-21, looking at an empty archive: "everything should [be] here
 * as well." The archive only ever captured mail a human thought to BCC, which
 * is why it held zero rows after four days of live use — the platform was
 * sending invoices, proposals and change orders past its own record of them.
 *
 * ── The rules, in one place, because five senders need the same answer ─────
 *
 * 1. FILE AGAINST THE JOB when there is one, the GC otherwise. A statement is
 *    account-level and belongs on the GC; an invoice belongs on the job it
 *    bills. An invoice with no opportunity (rare, but the column is nullable)
 *    falls back to the account rather than not being filed at all.
 *
 * 2. NEVER ADD A NULL. `buildArchiveAddress` returns null when
 *    COMMERCIAL_ARCHIVE_HMAC_SECRET is unset, because an address it cannot
 *    verify on the way back in would be silently dropped. A null pushed into a
 *    BCC array is an invalid recipient, and Resend rejects the WHOLE send —
 *    turning a missing archive into a failed invoice.
 *
 * 3. NEVER DUPLICATE, and never reveal. The address is dropped if it already
 *    appears anywhere on the message, and it is only ever a BCC — it is an
 *    HMAC-signed internal address and has no business being visible to a GC.
 *
 * 4. THE ARCHIVE IS NEVER WORTH FAILING A SEND OVER. Every call is wrapped so
 *    a bad id or a thrown builder returns "no extra recipients" rather than an
 *    exception — the invoice matters more than the copy of it.
 */

export type ArchiveTarget = {
  /** The job this document belongs to, when it has one. */
  opportunityId?: string | null;
  /** The GC. Used when there is no job, and it is what a statement files against. */
  accountId?: string | null;
};

/**
 * The archive BCC for a send, or `[]`.
 *
 * Returns an array so callers can spread it straight into an existing BCC list
 * without a null check — the shape that makes rule 2 hard to get wrong.
 */
export function archiveBccFor(target: ArchiveTarget): string[] {
  try {
    const oppId = (target.opportunityId ?? "").trim();
    const accId = (target.accountId ?? "").trim();
    // Prefer the job: it is the narrower, more useful filing, and the hub
    // links an opp-filed email to the deal's Activity tab.
    const addr = oppId
      ? buildArchiveAddress("opp", oppId)
      : accId
        ? buildArchiveAddress("acc", accId)
        : null;
    return addr ? [addr] : [];
  } catch (err) {
    console.warn("[email-archive] could not build the archive BCC:", (err as Error)?.message);
    return [];
  }
}

/**
 * Merge the archive address into a BCC list, de-duplicated against every
 * address already on the message.
 *
 * `existingBcc` is returned unchanged when the archive is unconfigured, so a
 * caller can use this unconditionally.
 */
export function withArchiveBcc(
  existingBcc: readonly string[],
  target: ArchiveTarget,
  alsoVisible: ReadonlyArray<string | null | undefined> = []
): string[] {
  const seen = new Set(
    [...existingBcc, ...alsoVisible]
      .map((e) => (e ?? "").trim().toLowerCase())
      .filter(Boolean)
  );
  const extra = archiveBccFor(target).filter((a) => !seen.has(a.toLowerCase()));
  return [...existingBcc, ...extra];
}
