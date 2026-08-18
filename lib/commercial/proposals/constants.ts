/**
 * Phase F.1 Proposals — enums, defaults, display helpers.
 *
 * Tomco defaults captured from 5 real 2026 proposals (Rodeo / Prime Place /
 * Water Lilies / Microchip / Brinkmann's). Do not paraphrase without
 * checking Katie — this text is what Tomco's customers expect to read.
 */

// ────────────── status enum ──────────────

export const PROPOSAL_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "sent",
  "won",
  "lost",
  "expired",
  "superseded",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** Which opportunity statuses are eligible to have a new proposal
 *  started on them. Pre-Sale open lanes. Shared by /commercial/proposals's
 *  <NewProposalPicker> AND the account detail Proposals sub-tab so
 *  both surfaces stay in sync. */
export const PROPOSAL_ELIGIBLE_OPP_STATUSES: readonly string[] = [
  "qualifying",
  "estimating",
  "proposal",
] as const;

/** Can a NEW proposal be started on this opportunity?
 *  - Pre-Sale open lanes (qualifying / estimating / proposal): yes.
 *  - WON deals: yes — a deal can be won without ever going through the
 *    proposal builder (e.g. dragged straight to Won), and you should still be
 *    able to attach/document its proposal. The send flow guards a won deal
 *    from moving backward, so this is safe.
 *  - LOST / no-bid / post-sale: no.
 *  Karan 2026-07-25: won-deal dead-end fix (a won deal with no proposal was
 *  unreachable from both the picker and the account Proposals tab). */
export function isProposalEligibleOpp(opp: {
  status: string;
  sub_status?: string | null;
}): boolean {
  if (PROPOSAL_ELIGIBLE_OPP_STATUSES.includes(opp.status)) return true;
  if (opp.status === "pre_sale_closed" && opp.sub_status === "won") return true;
  return false;
}

const STATUS_LABELS: Record<ProposalStatus, string> = {
  draft: "Draft",
  pending_approval: "Pending Approval",
  approved: "Approved",
  sent: "Sent",
  won: "Won",
  lost: "Lost",
  expired: "Expired",
  // Karan 2026-07-15: "Superseded" was too jargon-y. This state means
  // "an older revision that was replaced by a newer one" — call it
  // exactly that. DB value stays 'superseded' (renaming would need a
  // migration + reflow); only the human-facing label changes.
  superseded: "Replaced by newer",
};

export function proposalStatusLabel(s: string): string {
  return (STATUS_LABELS as Record<string, string>)[s] ?? s;
}

// ────────────── DAG-style allowed transitions ──────────────

/** Which target statuses are reachable from each source. Used by the
 *  editor UI to filter the action set on a given proposal. The status
 *  a proposal ships with is `draft`; sending it flips to `sent`; the
 *  customer's response feeds won/lost/expired. */
export const PROPOSAL_ALLOWED_TRANSITIONS: Record<
  ProposalStatus,
  readonly ProposalStatus[]
> = {
  // HARD GATE (Karan 2026-08): draft can NO LONGER go straight to sent — it must
  // pass through pending_approval → approved first. Send is blocked until approved.
  draft: ["pending_approval", "superseded"],
  // pending_approval → approved is APPROVER-ONLY (enforced in db.ts approveProposal
  // + outcome route); → draft is "request changes" (also approver-only).
  pending_approval: ["approved", "draft", "superseded"],
  // approved → sent is the real send; → draft is "unlock to edit" (invalidates approval).
  approved: ["sent", "draft", "superseded"],
  sent: ["won", "lost", "expired", "superseded"],
  // Karan 2026-07-15: won/lost are NO LONGER terminal — if Alex
  // accidentally marks a proposal Won (or the GC changes their mind
  // after marking Lost), we need an undo path. Both flip back to
  // Sent via the `reopenProposal` helper which also un-flips the
  // parent deal from pre_sale_closed back to Proposal · Sent.
  won: ["sent"],
  lost: ["sent"],
  // Not-quite-terminal: expired means the customer took too long. Reopen it
  // to DRAFT to tweak + re-approve + re-send (the send path requires approval,
  // so a bare expired→sent was a dead-end — you'd never get past Send).
  // Replacing it with a newer revision is the other option.
  expired: ["draft", "superseded"],
  superseded: [],
};

// ────────────── Tomco default intro paragraph ──────────────

/** Verbatim intro from every real 2026 Tomco proposal. Editable per
 *  proposal via `commercial_proposals.intro_text_override`. */
/**
 * The default intro paragraph, with the bid set folded into the opening
 * sentence when one is on file.
 *
 * Stephanie 2026-08-13: *"There is a place when building the proposal that
 * adds the bid plan set date, it should carry onto the customers proposal in
 * the intro paragraph. Tomco is pleased to provide the following proposal
 * based on plans dated 11/11/11."*
 *
 * It previously trailed as a separate sentence after the paragraph, which
 * reads as a footnote. Which drawing set was priced is part of WHAT is being
 * proposed, so it belongs in the first sentence — the clause a GC checks
 * first when the drawings have been revised twice since the walk-through.
 *
 * The date is spelled out (November 11, 2011) rather than 11/11/11, matching
 * every other date on the document.
 */
export function tomcoDefaultIntro(bidSetDateLabel?: string | null): string {
  const lead = bidSetDateLabel?.trim()
    ? `Tomco is pleased to provide the following proposal based on plans dated ${bidSetDateLabel.trim()}`
    : "Tomco is pleased to provide the following proposal";
  return `${lead}. Provide all necessary material, equipment, and skilled labor to complete the project in a quality and professional manner.`;
}

// ────────────── Company footer (bottom of every Tomco PDF) ──────────────

export const TOMCO_COMPANY_FOOTER = {
  address_line: "77-13 Windsor Place · Central Islip, NY 11722",
  contact_line: "Tel: 631.582.2770 · Fax: 631.582.2771 · Web: www.tomcopainting.com",
};

// ────────────── TOTAL label variants (per Tomco convention) ──────────────

/** When "Materials" is one of the picked exclusions, the TOTAL line
 *  reads "Labor Only TOTAL" instead of just "TOTAL". Everything else
 *  keeps the plain label. Called from the PDF renderer + the editor's
 *  live-preview total. */
export function proposalTotalLabel(exclusionTexts: readonly string[]): string {
  // Match any exclusion that STARTS with "materials" (2026-07-27 audit) — an
  // exact-string match missed real variants like "Materials excluded" or
  // "Materials (labor only)", leaving a labor-only bid labeled plain "TOTAL".
  const materialsExcluded = exclusionTexts.some((t) => /^materials\b/i.test(t.trim()));
  return materialsExcluded ? "Labor Only TOTAL" : "TOTAL";
}

// ────────────── outcome bucket for reporting ──────────────

// ────────────── revision lifecycle (Karan meeting 2026-08) ──────────────

/**
 * Whether a proposal should show an R# at all, and what it should say.
 *
 * Karan, verbatim: "it should be original and the revisions only come after
 * we send them to the client … we don't want the R1, R2 etc before we send it
 * to the client."
 *
 * So a proposal nobody outside the building has seen is just "the proposal".
 * Revision numbering starts the moment the DEAL has had something sent to the
 * client — not when a draft is bumped internally. Estimators bump drafts while
 * they're still pricing, and labelling those R2/R3 tells the client we've
 * revised something they never received.
 *
 * `anySentOnDeal` is the deal-level fact (any sibling with a `sent_at`). Pass
 * it wherever the caller already has the sibling list; the fallback to this
 * proposal's own `sent_at` is correct for a single-proposal deal and errs
 * toward hiding the label, which is the direction Karan asked for.
 */
export function proposalRevisionLabel(
  proposal: { revision_number: number; sent_at?: string | null },
  anySentOnDeal?: boolean
): string {
  const numberingStarted = anySentOnDeal ?? proposal.sent_at != null;
  return numberingStarted ? `R${proposal.revision_number}` : "";
}

/**
 * Is this proposal LOCKED against edits?
 *
 * Karan: "It will be locked once it's sent for approval." Two gates, both
 * meaning "someone outside the estimator is now relying on this":
 *   - sent for internal approval (pending_approval) or approved, and
 *   - anything the client has seen or decided (sent / won / lost), plus the
 *     archival states.
 *
 * Only `draft` is freely editable. Unlocking an approved proposal is a
 * deliberate, audited action (unlockApprovedProposal) — this predicate is the
 * read-side truth, not a substitute for that.
 */
export const EDITABLE_PROPOSAL_STATUSES: readonly ProposalStatus[] = ["draft"];
