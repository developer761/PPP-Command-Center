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
  draft: ["pending_approval", "sent", "superseded"],
  pending_approval: ["draft", "sent", "superseded"],
  sent: ["won", "lost", "expired", "superseded"],
  // Karan 2026-07-15: won/lost are NO LONGER terminal — if Alex
  // accidentally marks a proposal Won (or the GC changes their mind
  // after marking Lost), we need an undo path. Both flip back to
  // Sent via the `reopenProposal` helper which also un-flips the
  // parent deal from pre_sale_closed back to Proposal · Sent.
  won: ["sent"],
  lost: ["sent"],
  // Not-quite-terminal: expired means the customer took too long. Alex
  // can extend the deadline + re-send the SAME revision instead of
  // bumping, which is faster.
  expired: ["sent"],
  superseded: [],
};

// ────────────── Tomco default intro paragraph ──────────────

/** Verbatim intro from every real 2026 Tomco proposal. Editable per
 *  proposal via `commercial_proposals.intro_text_override`. */
export const TOMCO_DEFAULT_INTRO =
  "Tomco is pleased to provide the following proposal. Provide all necessary material, equipment, and skilled labor to complete the project in a quality and professional manner.";

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

/** Group statuses for the pipeline / win-loss report. */
export function proposalOutcomeBucket(
  s: string
): "open" | "awarded" | "not_awarded" {
  if (s === "won") return "awarded";
  if (s === "lost" || s === "expired") return "not_awarded";
  return "open";
}
