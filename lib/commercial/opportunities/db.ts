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
  oppStatusDisplayLabel,
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
  oppStatusDisplayLabel,
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
  // location_short (migration 046) fully retired 2026-07-21: backfilled
  // into property_street by migration 066, column dropped by migration
  // 068, and the last code readers removed here. property_street is the
  // sole site-address field now.
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
  // Migration 065 (Phase G Q1) — per-account sequential deal ID,
  // e.g. "ALT-0125". Assigned automatically on insert by
  // assignDealNumber(). Nullable at row level (backward compat) but
  // every new opp gets one via createCommercialOpportunity.
  deal_number: string | null;
  // Migration 067 (Phase G Q3) — archive support. Archived opps are
  // hidden from active pipeline/list by default; toggle "Include
  // archived" filter to see them. Reversible via unarchive.
  archived_at: string | null;
  archived_by_user_id: string | null;
  // Migration 069 (Katie 2026-07-20) — RFP arrival date. Powers the
  // time-to-proposal metric (proposal.sent_at - rfp_received_at).
  rfp_received_at: string | null;
  // Migration 069 (Katie 2026-07-20) — user-supplied custom deal name.
  // When set, derivedOppName returns this verbatim instead of the
  // computed {account}—{client}—{street}. Leave NULL to auto-derive.
  title_override: string | null;
};

/**
 * Derived display name — {account} - {client_name} - {property_street}.
 * Priority order:
 *   1. opp.title_override (migration 069) — user's custom name wins if set.
 *   2. Computed {account} - {client} - {street}. If client_name is blank,
 *      it's dropped from the join so we get {account} - {street}.
 *   3. opp.title fallback for legacy rows created before Phase B.
 *
 * Katie 2026-07-20: switched separator em-dash `—` → hyphen ` - ` to
 * match her verbatim spec + made client_name-drop explicit + added
 * title_override precedence for editable names.
 */
export function derivedOppName(
  opp: Pick<CommercialOpportunity, "title" | "client_name"> & {
    property_street?: string | null;
    title_override?: string | null;
  },
  accountName: string | null | undefined,
): string {
  // (1) Explicit user override wins.
  const override = opp.title_override?.trim();
  if (override) return override;

  // (2) Computed. client_name is optional per Katie's spec: "If Client
  //     Name is blank, then leave it out."
  const parts: string[] = [];
  if (accountName && accountName.trim()) parts.push(accountName.trim());
  if (opp.client_name && opp.client_name.trim()) parts.push(opp.client_name.trim());
  const location = (opp.property_street && opp.property_street.trim()) || "";
  if (location) parts.push(location);

  // Need at least 2 parts to render the join; solo account name alone
  // is uninformative next to opp.title. Otherwise: {account} - {client}
  // or {account} - {street} or full {account} - {client} - {street}.
  if (parts.length >= 2) return parts.join(" - ");

  // (3) Legacy fallback — Phase B structural fields not populated yet.
  return opp.title || parts[0] || "Untitled opportunity";
}

/** Format a deal number for display. Prefixes "No. " to match Tomco's
 *  letterhead convention ("No. ALT-0125"). Renders empty string if the
 *  opp has no deal_number yet (pre-migration-065 or migration failure). */
export function formatDealNumber(dealNumber: string | null | undefined): string {
  const raw = dealNumber?.trim();
  if (!raw) return "";
  return /^no\./i.test(raw) ? raw : `No. ${raw}`;
}

export type OpportunitiesListFilters = {
  search?: string;
  status?: OpportunityStatus;
  accountId?: string;
  /** Migration 067 (Phase G Q3): default = false, hides archived opps
   *  from the active pipeline / list. Pass true on the /archived view
   *  to render only archived rows for unarchive. */
  includeArchived?: boolean;
  /** When true, list ONLY archived opps (the archived-view page).
   *  Combine with an account filter to see one GC's archived deals. */
  onlyArchived?: boolean;
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

  // Archive filter — mutually exclusive modes:
  //   onlyArchived=true  → archived_at IS NOT NULL (archived-view page)
  //   includeArchived=true → no filter (show both)
  //   default            → archived_at IS NULL (active pipeline)
  if (filters.onlyArchived) {
    q = q.not("archived_at", "is", null);
  } else if (!filters.includeArchived) {
    q = q.is("archived_at", null);
  }

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

// ────────────── Migration 065 (Phase G Q1) — deal number ──────────────

/** Assign the next per-account sequential deal number ("ALT-0125").
 *  Atomic via `UPDATE ... RETURNING` on the counter table. Auto-seeds
 *  the counter row if none exists. Falls back to "GC" prefix if the
 *  account has no derivable code (rare — backfill migration set one).
 *
 *  Returns null on error rather than throwing so a failed counter
 *  doesn't block opportunity creation — the row inserts with
 *  deal_number = NULL and can be repaired later via admin. */
export async function assignDealNumber(
  accountId: string
): Promise<string | null> {
  const sb = commercialDb();

  // Ensure counter row exists (idempotent — first insert on new account
  // sets next_seq = 1; subsequent calls no-op via ON CONFLICT).
  const { error: seedErr } = await sb
    .from("commercial_account_deal_counter")
    .upsert({ account_id: accountId }, { onConflict: "account_id", ignoreDuplicates: true });
  if (seedErr) {
    console.warn("[assignDealNumber] seed counter failed:", seedErr.message);
    return null;
  }

  // Atomically increment via SELECT-then-UPDATE-WHERE-next_seq=X CAS.
  // Bounded retry loop (5 tries) instead of retry-once. Phase G audit
  // finding: at Tomco's volume the odds of two consecutive CAS losses
  // are astronomically low, but "return null → NULL deal_number → admin
  // repair" is enough of a mess that a bounded loop is worth the code.
  // 5 tries handles theoretical thundering-herd across CSV imports.
  const MAX_TRIES = 5;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const { data: cur } = await sb
      .from("commercial_account_deal_counter")
      .select("next_seq")
      .eq("account_id", accountId)
      .maybeSingle();
    const currentSeq = (cur as { next_seq?: number } | null)?.next_seq;
    if (typeof currentSeq !== "number") {
      console.warn("[assignDealNumber] counter row missing for", accountId);
      return null;
    }
    const { data: upd, error: updErr } = await sb
      .from("commercial_account_deal_counter")
      .update({ next_seq: currentSeq + 1, updated_at: new Date().toISOString() })
      .eq("account_id", accountId)
      .eq("next_seq", currentSeq)
      .select("next_seq")
      .maybeSingle();
    if (upd && !updErr) {
      return await formatDealNumberForAccount(accountId, currentSeq);
    }
    if (updErr) {
      console.warn(
        `[assignDealNumber] attempt ${attempt + 1}/${MAX_TRIES} DB error:`,
        updErr.message
      );
      return null;
    }
    // upd is null → CAS lost; another concurrent insert won this seq.
    // Loop tries again with a fresh SELECT.
  }
  console.warn(
    `[assignDealNumber] all ${MAX_TRIES} CAS attempts lost for account`,
    accountId
  );
  return null;
}

async function formatDealNumberForAccount(
  accountId: string,
  seq: number
): Promise<string | null> {
  const sb = commercialDb();
  const { data: acc } = await sb
    .from("commercial_accounts")
    .select("deal_code_prefix")
    .eq("id", accountId)
    .maybeSingle();
  const prefix =
    (acc as { deal_code_prefix?: string | null } | null)?.deal_code_prefix?.trim() || "GC";
  return `${prefix}-${String(seq).padStart(4, "0")}`;
}

// ────────────── Migration 067 (Phase G Q3) — archive ──────────────

/** Archive an opp — hides from active pipeline/list but keeps
 *  dependents (proposals, invoices, submittals) visible in their own
 *  views. Reversible via unarchiveOpportunity. Idempotent — already
 *  archived rows return { ok: true } without a re-stamp. */
export async function archiveOpportunity(
  id: string,
  actorUserId: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_opportunities")
    .select("id, archived_at")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) return { ok: false, error: "Deal not found." };
  const b = before as { archived_at: string | null };
  if (b.archived_at) return { ok: true }; // already archived — idempotent
  const { error } = await sb
    .from("commercial_opportunities")
    .update({
      archived_at: new Date().toISOString(),
      archived_by_user_id: actorUserId,
      updated_by_user_id: actorUserId,
    })
    .eq("id", id)
    .is("archived_at", null); // CAS guard against double-archive race
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Unarchive an opp — restores to active pipeline. Idempotent. */
export async function unarchiveOpportunity(
  id: string,
  actorUserId: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_opportunities")
    .select("id, archived_at")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) return { ok: false, error: "Deal not found." };
  const b = before as { archived_at: string | null };
  if (!b.archived_at) return { ok: true }; // already active
  // Phase G audit MEDIUM: mirror the archive UPDATE's guard —
  // .is("deleted_at", null) on the UPDATE (defense-in-depth against
  // a soft-delete race). Also .not("archived_at", "is", null) CAS
  // guards against a concurrent unarchive click.
  const { error } = await sb
    .from("commercial_opportunities")
    .update({
      archived_at: null,
      archived_by_user_id: null,
      updated_by_user_id: actorUserId,
    })
    .eq("id", id)
    .is("deleted_at", null)
    .not("archived_at", "is", null);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
