/**
 * Shared record IDs — one number follows a deal through its whole life.
 *
 * Karan 2026-08 meeting, verbatim: "Need a unique identifier for each record …
 * Account (Acc-1234) · Opportunity (Opp-1234) · Proposal (Prop-1234) ·
 * Project (Proj-1234) · Work Order (WO-1234) · Transactions (Trans-1234) …
 * make sure the ending numbers are the same."
 *
 * The root is the opportunity's `project_number` (e.g. "2026-0020"), assigned
 * by the migration-046 trigger on insert. Every downstream record derives its
 * label from that same root, so a deal reads:
 *
 *   OPP-2026-0020 → PROP-2026-0020 → PROJ-2026-0020 → WO-2026-0020-A → TRANS-2026-0020-3
 *
 * DISPLAY LAYER ONLY — no migration, no new columns, no sequences to keep in
 * step. Each of these is derived at render time from data the row already has
 * (its parent deal's number, plus its own revision/position), which is also
 * why they can't drift apart: there is only one source.
 *
 * Two deliberate exceptions:
 *
 *   - ACC-#### stays independent. An account has many deals, so it cannot
 *     share a deal's number — the family is "everything belonging to ONE
 *     deal", and the account is the shelf those deals sit on.
 *   - Invoices keep their own INV-#### sequence. An invoice number is an
 *     accounting document reference that appears on money the customer has
 *     already paid against; renumbering those to match the deal would break
 *     the paper trail on both sides.
 */

/** Strip any prefix a caller may already have applied, so `dealNumberRoot`
 *  is idempotent and callers can pass a raw or formatted value. */
function rootOf(projectNumber: string | null | undefined): string {
  const raw = projectNumber?.trim();
  if (!raw) return "";
  return raw.replace(/^(opp|proj|prop|wo|trans)-/i, "");
}

/** The bare number every record on this deal shares, e.g. "2026-0020".
 *  Empty string when the deal has no number yet (the trigger assigns one on
 *  insert, but a backfilled or failed row can be null — callers render
 *  nothing rather than a bare prefix like "WO-"). */
export function dealNumberRoot(
  projectNumber: string | null | undefined
): string {
  return rootOf(projectNumber);
}

/**
 * Position suffix for records a deal can have MORE than one of.
 *
 * Work orders use letters (WO-2026-0020-A, -B) because a crew reads them
 * aloud — "double-oh-twenty A" — and letters can't be mistaken for part of
 * the number. Transactions use digits, since they're scanned in lists rather
 * than spoken, and a project can easily run past 26 of them.
 *
 * `index` is 0-based. Past 26 work orders it rolls to AA, AB, … rather than
 * repeating a letter, so two live WOs can never carry the same label.
 */
function letterSuffix(index: number): string {
  if (index < 0) return "";
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** OPP-2026-0020 — the pre-contract identity of the deal. */
export function opportunityRecordId(
  projectNumber: string | null | undefined
): string {
  const root = rootOf(projectNumber);
  return root ? `OPP-${root}` : "";
}

/**
 * PROJ-2026-0020 — the SAME deal once it's won.
 *
 * Project and Opportunity are one record (a won opportunity IS the project),
 * so this shares the number by construction. Showing PROJ- rather than OPP-
 * on post-contract surfaces is how the team can tell at a glance which side
 * of the contract a screen is about.
 */
export function projectRecordId(
  projectNumber: string | null | undefined
): string {
  const root = rootOf(projectNumber);
  return root ? `PROJ-${root}` : "";
}

/**
 * PROP-2026-0020, or PROP-2026-0020-R2 for a revision.
 *
 * Revision 1 carries no suffix on purpose: Karan's rule is that a proposal
 * is just "the proposal" until it has been sent and revised, so an R1 tag on
 * the original is noise the client shouldn't see.
 */
export function proposalRecordId(
  projectNumber: string | null | undefined,
  revisionNumber?: number | null
): string {
  const root = rootOf(projectNumber);
  if (!root) return "";
  // The R number counts REVISIONS, so it runs one behind revision_number —
  // the original has had none and carries no suffix at all. Brendan
  // 2026-09-03: "the original should have no R1 … then we create the R1 doc
  // the first revision." Same rule as proposalRevisionLabel; they appear side
  // by side on the proposal header and must not disagree.
  const rev = Math.round(Number(revisionNumber ?? 1)) - 1;
  return rev > 0 ? `PROP-${root}-R${rev}` : `PROP-${root}`;
}

/**
 * WO-2026-0020, or WO-2026-0020-A / -B when a project has several.
 *
 * A project splits into multiple work orders when different crews take
 * different scope (or different areas), so the suffix is what tells two
 * crews' marching orders apart. Pass `index` only when there IS more than
 * one — a lone work order reads cleaner without a trailing letter.
 */
export function workOrderRecordId(
  projectNumber: string | null | undefined,
  index?: number | null,
  total?: number | null
): string {
  const root = rootOf(projectNumber);
  if (!root) return "";
  const needsSuffix =
    index !== null && index !== undefined && (total ?? 0) > 1;
  return needsSuffix ? `WO-${root}-${letterSuffix(index)}` : `WO-${root}`;
}

/**
 * TRANS-2026-0020-3 — a transaction (purchase/receipt) against the project.
 *
 * Always suffixed: a project accrues many transactions and they're only ever
 * meaningful as "the third one on this job", so an unsuffixed TRANS- would be
 * ambiguous the moment there are two. `position` is 1-based to match how the
 * list is numbered on screen.
 */
export function transactionRecordId(
  projectNumber: string | null | undefined,
  position?: number | null
): string {
  const root = rootOf(projectNumber);
  if (!root) return "";
  return position && position > 0 ? `TRANS-${root}-${position}` : `TRANS-${root}`;
}
