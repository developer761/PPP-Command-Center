import "server-only";

import { commercialDb } from "@/lib/commercial/db";

/**
 * Read helpers + types for commercial_opportunities (migration 028).
 *
 * Strict separation: this file must not import from lib/salesforce/*.
 * Postgres is the source of truth for opportunities — there is no SF
 * mirror on the commercial side.
 */

export const OPPORTUNITY_STATUSES = [
  "inquiry",
  "site_visit_scheduled",
  "site_visit_done",
  "estimating",
  "proposal_sent",
  "negotiating",
  "on_hold",
  "won",
  "lost",
  "no_bid",
  "reopened",
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export function opportunityStatusLabel(s: OpportunityStatus): string {
  return {
    inquiry: "Inquiry",
    site_visit_scheduled: "Site visit scheduled",
    site_visit_done: "Site visit done",
    estimating: "Estimating",
    proposal_sent: "Proposal sent",
    negotiating: "Negotiating",
    on_hold: "On hold",
    won: "Won",
    lost: "Lost",
    no_bid: "No bid",
    reopened: "Reopened",
  }[s];
}

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

export const OPPORTUNITY_LOSS_REASONS = [
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
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  deleted_at: string | null;
};

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
  let q = sb
    .from("commercial_opportunities")
    .select("*")
    .is("deleted_at", null);

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
  return (data ?? []) as CommercialOpportunity[];
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
 *  cents (BIGINT-safe in JS since we cap well under MAX_SAFE_INTEGER). */
export function weightedPipelineCents(opp: CommercialOpportunity): number {
  const low = opp.bid_value_low_cents ?? 0;
  const high = opp.bid_value_high_cents ?? 0;
  if (low === 0 && high === 0) return 0;
  const mid = (low + (high || low)) / 2;
  return Math.round((mid * opp.probability_pct) / 100);
}
