import "server-only";

import { commercialDb } from "@/lib/commercial/db";

/**
 * Read helpers + types for commercial_opportunities (migration 028).
 *
 * Strict separation: this file must not import from lib/salesforce/*.
 * Postgres is the source of truth for opportunities — there is no SF
 * mirror on the commercial side.
 */

// Karan/Katie 2026-07-13 Status Model v2: two-lane, two-level model
// (Pre-Sale/Post-Sale × Status/Sub-Status). Migration 052 enforces the
// tuple + backfills every v1.1 row. See lib/commercial/opportunities/
// constants.ts for the full whitelist + lane derivation.
import {
  OPPORTUNITY_STATUSES,
  laneForStatus,
  opportunityStatusLabel,
  opportunityStatusLabelV2,
  opportunitySubStatusLabel,
  SUB_STATUSES_BY_STATUS,
  isValidSubStatus,
  DEFAULT_SUB_STATUS_BY_STATUS,
  type OpportunityStatus,
  type OpportunitySubStatus,
  type OpportunityLane,
} from "./constants";
export {
  OPPORTUNITY_STATUSES,
  laneForStatus,
  opportunityStatusLabel,
  opportunityStatusLabelV2,
  opportunitySubStatusLabel,
  SUB_STATUSES_BY_STATUS,
  isValidSubStatus,
  DEFAULT_SUB_STATUS_BY_STATUS,
};
export type { OpportunityStatus, OpportunitySubStatus, OpportunityLane };

export const OPPORTUNITY_SOURCES = [
  "email",
  "phone",
  "web",
  "plans_room",
  "repeat",
  "referral",
  "other",
] as const;
export type OpportunitySource = (typeof OPPORTUNITY_SOURCES)[number];

export function opportunitySourceLabel(s: OpportunitySource): string {
  return {
    email: "Email",
    phone: "Phone",
    web: "Web form",
    plans_room: "Plans room",
    repeat: "Repeat customer",
    referral: "Referral",
    other: "Other",
  }[s];
}

// Karan 2026-07-09 Phase A.1: `no_bid` added as a loss reason. The v1.0
// enum had `no_bid` as a first-class status, which the CEO's v1.1 list
// dropped. We keep the distinction (for Win/Loss reporting, competitor
// analysis, and "how many did we pass on vs actually lose") by moving
// it into the loss_reason enum. Migration 045 backfills historic no_bid
// rows into `lost` with `loss_reason='no_bid'`.
export const OPPORTUNITY_LOSS_REASONS = [
  "no_bid",
  "price",
  "scope",
  "timing",
  "no_decision",
  "awarded_to_competitor",
  "relationship",
  "other",
] as const;
export type OpportunityLossReason = (typeof OPPORTUNITY_LOSS_REASONS)[number];

export function opportunityLossReasonLabel(r: OpportunityLossReason): string {
  return {
    no_bid: "We declined to bid",
    price: "Price",
    scope: "Scope mismatch",
    timing: "Timing",
    no_decision: "No decision made",
    awarded_to_competitor: "Awarded to competitor",
    relationship: "Relationship",
    other: "Other",
  }[r];
}

export type CommercialOpportunity = {
  id: string;
  account_id: string;
  primary_contact_id: string | null;
  title: string;
  description: string | null;
  status: OpportunityStatus;
  /** v2 sub-status (migration 052). Whitelisted per parent status via
   *  SUB_STATUSES_BY_STATUS + DB CHECK. NEVER null on well-formed rows —
   *  the CHECK constraint refuses NULL. Nullable in TS only because
   *  Postgres schema tools may return string|null on the row shape. */
  sub_status: string | null;
  /** v2 follow-up scheduling (Katie's ask: reminder dates + notes). */
  follow_up_at: string | null;
  follow_up_notes: string | null;
  bid_value_low_cents: number | null;
  bid_value_high_cents: number | null;
  probability_pct: number;
  source: OpportunitySource | null;
  proposed_start_at: string | null;
  proposed_end_at: string | null;
  proposal_due_at: string | null;
  decided_at: string | null;
  loss_reason: OpportunityLossReason | null;
  loss_notes: string | null;
  // Per-opp project address (migration 035). Null when not set — UI
  // falls back to the parent account's site/billing address.
  property_street: string | null;
  property_city: string | null;
  property_state: string | null;
  property_zip: string | null;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  deleted_at: string | null;
  // Migration 038 — set when the Win/Loss Debrief was completed for the
  // current closure. NULL on terminal opps means "amber Debrief banner
  // shows on the opp page." Cleared on reopen.
  win_loss_debriefed_at: string | null;
  // Migration 046 (Phase B) — CEO structural fields. Nullable at row
  // level; changeOpportunityStatus enforces required-at-estimating for
  // client_name / location_short / estimator_user_id.
  client_name: string | null;
  location_short: string | null;
  estimator_user_id: string | null;
  // Migration 049 (Karan 2026-07-10) — free-text estimator name for
  // sub / GC-supplied / off-roster estimators. Takes precedence over
  // estimator_user_id at display time. One of the two is enough to
  // satisfy the estimating+ structural-fields gate.
  estimator_name: string | null;
  // project_number auto-populated by BEFORE INSERT trigger (YYYY-NNNN).
  project_number: string | null;
  // Migration 045 — snapshot of previous status; preserves context for
  // rows migrated from v1.0's `reopened` value.
  previous_status: string | null;
};

/**
 * Derived display name — {account} - {client_name} - {location_short}.
 * Falls back to opp.title when structural fields are unpopulated (which
 * is the state of every row created before Phase B ships).
 *
 * Called from every place that displays an opportunity name: list rows,
 * kanban cards, hero titles, breadcrumbs, CSV exports, bell + email
 * notification bodies. Keep this the single source of truth — direct
 * `opp.title` reads on customer-facing surfaces will drift.
 */
export function derivedOppName(
  opp: Pick<CommercialOpportunity, "title" | "client_name" | "location_short">,
  accountName: string | null | undefined,
): string {
  const parts: string[] = [];
  if (accountName && accountName.trim()) parts.push(accountName.trim());
  if (opp.client_name && opp.client_name.trim()) parts.push(opp.client_name.trim());
  if (opp.location_short && opp.location_short.trim()) parts.push(opp.location_short.trim());
  // Structural form needs at least client_name + location_short (the
  // two Phase B fields). Falls back to opp.title otherwise — including
  // for accounts-only titles like "Solicitation from BobCo" where we
  // haven't captured the client/location yet.
  if (parts.length >= 2 && opp.client_name && opp.location_short) {
    return parts.join(" — ");
  }
  return opp.title || parts.join(" — ") || "Untitled opportunity";
}

export type OpportunitiesListFilters = {
  search?: string;
  status?: OpportunityStatus;
  accountId?: string;
};

/** List non-deleted opportunities, optionally scoped by status / search /
 *  account. Returns empty array on error so the page renders the empty
 *  state cleanly. */
export async function listCommercialOpportunities(
  filters: OpportunitiesListFilters = {}
): Promise<CommercialOpportunity[]> {
  const sb = commercialDb();
  // Inner-join the account so a soft-deleted parent's opps drop out of
  // the pipeline view (audit fix 2026-06-16 — without this, bulk-deleting
  // an account leaves its bids orphaned on /commercial/opportunities).
  // `account:commercial_accounts!inner(deleted_at)` is the Supabase
  // pattern for "must exist + must match the filter below."
  let q = sb
    .from("commercial_opportunities")
    .select("*, account:commercial_accounts!inner(deleted_at)")
    .is("deleted_at", null)
    .is("account.deleted_at", null);

  if (filters.search) {
    const term = `%${filters.search.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    q = q.ilike("title", term);
  }
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.accountId) q = q.eq("account_id", filters.accountId);

  const { data, error } = await q.order("updated_at", { ascending: false });
  if (error) {
    console.warn("[commercial/opportunities] list failed:", error.message);
    return [];
  }
  // Strip the join shape — callers want plain CommercialOpportunity[].
  return (data ?? []).map((r) => {
    const { account: _unused, ...rest } = r as CommercialOpportunity & { account: unknown };
    return rest as CommercialOpportunity;
  });
}

/** Load a single opportunity by id, filtering soft-deleted. */
export async function getCommercialOpportunity(
  id: string
): Promise<CommercialOpportunity | null> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_opportunities")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    console.warn("[commercial/opportunities] get failed:", error.message);
    return null;
  }
  return (data as CommercialOpportunity | null) ?? null;
}

/** Load a single opportunity including soft-deleted rows. Karan 2026-07-08:
 *  the deal-detail page needs to still open for a deleted deal so users can
 *  reach the invoices tab (money history) and either void/delete stragglers
 *  or record last payments. Callers should render a "deal deleted" banner
 *  when `deleted_at` is set. Live-only surfaces should keep using
 *  `getCommercialOpportunity`. */
export async function getCommercialOpportunityIncludingDeleted(
  id: string
): Promise<CommercialOpportunity | null> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_opportunities")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.warn("[commercial/opportunities] get(inc-deleted) failed:", error.message);
    return null;
  }
  return (data as CommercialOpportunity | null) ?? null;
}

/** Bid range as a display string ("$50k–$75k", "$25,000", "—"). */
export function formatBidRange(low: number | null, high: number | null): string {
  if (low === null && high === null) return "—";
  const fmt = (cents: number) => {
    const dollars = cents / 100;
    if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
    if (dollars >= 1_000) return `$${Math.round(dollars / 1_000)}k`;
    return `$${dollars.toLocaleString()}`;
  };
  if (low === null) return `≤ ${fmt(high!)}`;
  if (high === null) return `≥ ${fmt(low)}`;
  if (low === high) return fmt(low);
  return `${fmt(low)}–${fmt(high)}`;
}

/** Weighted pipeline value for one opp: midpoint × probability. Returns
 *  cents (BIGINT-safe in JS since we cap well under MAX_SAFE_INTEGER).
 *
 *  Edge cases:
 *    - both null → 0 (no bid yet, contributes nothing to pipeline)
 *    - both set  → midpoint × prob
 *    - low only  → low × prob (treat as point estimate)
 *    - high only → high × prob (treat as point estimate, NOT high/2)
 *
 *  The earlier implementation collapsed low=null into 0 then computed
 *  (0 + high) / 2 = high/2, which silently halved the pipeline value of
 *  any opp where only an upper bound was entered. Now uses null checks
 *  so the "point estimate" cases preserve their full weight.
 */
export function weightedPipelineCents(opp: CommercialOpportunity): number {
  const low = opp.bid_value_low_cents;
  const high = opp.bid_value_high_cents;
  if ((low === null || low === undefined) && (high === null || high === undefined)) return 0;
  const mid =
    low !== null && low !== undefined && high !== null && high !== undefined
      ? (low + high) / 2
      : (low ?? high) ?? 0;
  return Math.round((mid * opp.probability_pct) / 100);
}
