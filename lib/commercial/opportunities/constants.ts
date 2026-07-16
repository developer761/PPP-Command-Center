/**
 * Opportunity Pipeline — v2 Status Model (Katie/Karan 2026-07-13).
 *
 * Two-lane, two-level model:
 *   PRE-SALE:  Qualifying → Estimating → Proposal → Closed
 *   POST-SALE: Pre-Construction → In Progress → Billing → Closed
 *
 * Every opportunity has BOTH a `status` (one of 8) AND a `sub_status`
 * (whitelisted per parent status). Migration 052 enforces the tuple
 * via a CHECK constraint. Lane is derived from status.
 *
 * Migration 052 backfills every v1.1 row into a v2 (status, sub_status)
 * tuple. See the migration for the exact mapping.
 */

// ═══════════════════════════════════════════════════════════════════
// Statuses (top level, 8 total)
// ═══════════════════════════════════════════════════════════════════

export const PRE_SALE_STATUSES = [
  "qualifying",
  "estimating",
  "proposal",
  "pre_sale_closed",
] as const;

export const POST_SALE_STATUSES = [
  "pre_construction",
  "in_progress",
  "billing",
  "post_sale_closed",
] as const;

export const OPPORTUNITY_STATUSES = [
  ...PRE_SALE_STATUSES,
  ...POST_SALE_STATUSES,
] as const;

/** v1.1 status values kept in the TS union so callsites doing
 *  `opp.status === "won"` still compile. At runtime, migration 052 has
 *  already backfilled every row into a v2 status, so these comparisons
 *  are dead code — they'll always be false. Callers should migrate to
 *  `isWon(opp)` / `isLost(opp)` semantic helpers.
 *
 *  Karan/Katie 2026-07-13: this is a deliberate migration compat layer
 *  so the UI keeps working while we sweep the codebase to v2 semantics
 *  file-by-file. Delete this once every `opp.status === "won"` (v1
 *  compare) has been replaced.
 */
export const LEGACY_V1_STATUSES = [
  "solicitation",
  "rfp",
  "proposal_pending_approval",
  "proposal_sent",
  "follow_up",
  "won",
  "lost",
] as const;

export type OpportunityStatus =
  | (typeof OPPORTUNITY_STATUSES)[number]
  | (typeof LEGACY_V1_STATUSES)[number];

// ═══════════════════════════════════════════════════════════════════
// Sub-statuses (whitelisted per parent status)
// ═══════════════════════════════════════════════════════════════════

/** Per-parent sub-status whitelist. Mirrors the CHECK constraint in
 *  migration 052 exactly — do not diverge without a migration. */
type V2Status = (typeof OPPORTUNITY_STATUSES)[number];

export const SUB_STATUSES_BY_STATUS = {
  qualifying: ["solicitation", "rfp", "estimating"] as const,
  // Katie's 2026-07-13 spec: `estimating` top-level has TWO sub-statuses,
  // "Estimating" (we're actively pricing) and "Proposal Pending Approval"
  // (priced, awaiting sign-off). Migration 053 widens the DB CHECK to
  // match. See supabase/migrations/053_add_estimating_sub_status.sql.
  estimating: ["estimating", "proposal_pending_approval"] as const,
  proposal: ["sent", "follow_up"] as const,
  pre_sale_closed: ["won", "lost"] as const,
  pre_construction: ["coordination", "ready_to_mobilize"] as const,
  in_progress: ["wip_on_site", "wip_on_hold"] as const,
  billing: ["substantial_completion", "completed_and_invoiced"] as const,
  post_sale_closed: ["closeout", "closed"] as const,
} as const satisfies Record<V2Status, readonly string[]>;

export type OpportunitySubStatus =
  (typeof SUB_STATUSES_BY_STATUS)[V2Status][number];

/** Predicate: is this (status, sub_status) tuple actually valid?
 *  Matches the DB CHECK constraint. Use before writing to the DB. */
export function isValidSubStatus(
  status: string,
  subStatus: string | null | undefined
): boolean {
  if (!subStatus) return false;
  const allowed = (SUB_STATUSES_BY_STATUS as Record<string, readonly string[]>)[
    status
  ];
  if (!allowed) return false;
  return allowed.includes(subStatus);
}

/** Default sub-status when a caller flips to a new status without
 *  specifying one. Chooses the "starting" sub-status of each lane —
 *  the natural entry point when a deal first moves in. Estimating's
 *  natural entry is "estimating" (we're pricing), not
 *  "proposal_pending_approval" (that comes AFTER pricing). */
export const DEFAULT_SUB_STATUS_BY_STATUS: Record<V2Status, string> = {
  qualifying: "solicitation",
  estimating: "estimating",
  proposal: "sent",
  pre_sale_closed: "won",
  pre_construction: "coordination",
  in_progress: "wip_on_site",
  billing: "substantial_completion",
  post_sale_closed: "closeout",
};

// ═══════════════════════════════════════════════════════════════════
// Lane derivation
// ═══════════════════════════════════════════════════════════════════

export type OpportunityLane = "pre_sale" | "post_sale";

const PRE_SALE_STATUS_SET = new Set<string>(PRE_SALE_STATUSES);

export function laneForStatus(status: string): OpportunityLane {
  return PRE_SALE_STATUS_SET.has(status) ? "pre_sale" : "post_sale";
}

// ═══════════════════════════════════════════════════════════════════
// Labels (human-readable)
// ═══════════════════════════════════════════════════════════════════

const STATUS_LABELS: Record<V2Status, string> = {
  qualifying: "Qualifying",
  estimating: "Estimating",
  proposal: "Proposal",
  pre_sale_closed: "Closed",
  pre_construction: "Pre-Construction",
  in_progress: "In Progress",
  billing: "Billing",
  post_sale_closed: "Closed",
};

/** V2 status label. Handles retired v1 values as read-only fallback so
 *  a stale bell notification or webhook doesn't crash the UI. */
export function opportunityStatusLabelV2(
  s: string | null | undefined
): string {
  if (!s) return "Unknown";
  const v2 = (STATUS_LABELS as Record<string, string>)[s];
  if (v2) return v2;
  // v1 legacy labels — these values are still used as Kanban drop-target
  // keys ("won"/"lost") in the terminal cluster, so the labels here are
  // plain human-readable strings, not debug-tagged with "(v1)".
  const v1Retired: Record<string, string> = {
    solicitation: "Solicitation",
    rfp: "RFP",
    proposal_pending_approval: "Proposal pending",
    proposal_sent: "Proposal sent",
    follow_up: "Follow up",
    won: "Won",
    lost: "Lost",
    inquiry: "Inquiry",
    negotiating: "Negotiating",
    on_hold: "On hold",
    no_bid: "No bid",
    reopened: "Reopened",
    site_visit_scheduled: "Site visit scheduled",
    site_visit_done: "Site visit done",
  };
  return (
    v1Retired[s] ?? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ")
  );
}

/** Alias for the previous single-arg helper — kept so existing callsites
 *  don't all break. New code should call opportunityStatusLabelV2. */
export function opportunityStatusLabel(
  s: string | null | undefined
): string {
  return opportunityStatusLabelV2(s);
}

/** Display label that collapses the (pre_sale_closed, won/lost) tuple to
 *  "Won" or "Lost" for pill labels. Karan 2026-07-13: on decided rows the
 *  user wants the outcome word, not "Closed", so at-a-glance scan reads
 *  "Won" instead of a bland terminal state. */
export function oppStatusDisplayLabel(
  status: string | null | undefined,
  sub_status: string | null | undefined
): string {
  if (status === "pre_sale_closed") {
    if (sub_status === "won") return "Won";
    if (sub_status === "lost") return "Lost";
  }
  return opportunityStatusLabelV2(status);
}

// Katie's 2026-07-13 status structure — labels below are copied verbatim
// from her spec so the UI matches the language she uses with Alex and
// the delivery team. Do NOT abbreviate ("Sent" → "Proposal Sent",
// "On site" → "WIP On Site", etc.) without checking with Katie.
const SUB_STATUS_LABELS: Record<string, string> = {
  // qualifying
  solicitation: "Solicitation",
  rfp: "Request for Proposal (RFP)",
  estimating: "Estimating",
  // estimating (top-level)
  proposal_pending_approval: "Proposal Pending Approval",
  // proposal
  sent: "Proposal Sent",
  follow_up: "Follow Up",
  // pre_sale_closed
  won: "Won",
  lost: "Lost",
  // pre_construction
  coordination: "Coordination",
  ready_to_mobilize: "Ready to Mobilize",
  // in_progress
  wip_on_site: "WIP On Site",
  wip_on_hold: "WIP On Hold",
  // billing
  substantial_completion: "Substantial Completion",
  completed_and_invoiced: "Completed and Invoiced",
  // post_sale_closed
  closeout: "Completed / Close-Out Docs",
  closed: "Closed",
};

export function opportunitySubStatusLabel(
  s: string | null | undefined
): string {
  if (!s) return "";
  return SUB_STATUS_LABELS[s] ?? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

// ═══════════════════════════════════════════════════════════════════
// Probability defaults
//
// v2 shift: probability tracks the SUB-STATUS (finer granularity than
// v1 which tracked status). A repeat customer on Qualifying/Solicitation
// is still a ~10% bet; Proposal/Sent is ~65%. Post-sale opportunities
// are 100% (already won).
// ═══════════════════════════════════════════════════════════════════

export const DEFAULT_PROBABILITY_BY_SUB_STATUS: Record<string, number> = {
  // pre-sale
  solicitation: 10,
  rfp: 20,
  estimating: 30, // qualifying/estimating (intake) — before real work
  proposal_pending_approval: 55,
  sent: 65,
  follow_up: 65, // sentinel — probability preserved on entry
  won: 100,
  lost: 0,
  // post-sale (all won implicitly)
  coordination: 100,
  ready_to_mobilize: 100,
  wip_on_site: 100,
  wip_on_hold: 100,
  substantial_completion: 100,
  completed_and_invoiced: 100,
  closeout: 100,
  closed: 100,
};

/** DEPRECATED shim — kept so callers importing DEFAULT_PROBABILITY_BY_STATUS
 *  (v1.1) don't break during the migration. Prefer the sub-status version
 *  above. Maps status → probability of its DEFAULT sub-status. */
export const DEFAULT_PROBABILITY_BY_STATUS: Record<string, number> = {
  qualifying: DEFAULT_PROBABILITY_BY_SUB_STATUS.solicitation,
  estimating: DEFAULT_PROBABILITY_BY_SUB_STATUS.proposal_pending_approval,
  proposal: DEFAULT_PROBABILITY_BY_SUB_STATUS.sent,
  pre_sale_closed: DEFAULT_PROBABILITY_BY_SUB_STATUS.won,
  pre_construction: 100,
  in_progress: 100,
  billing: 100,
  post_sale_closed: 100,
  // v1.1 alias fallbacks so anything writing pre-migration doesn't NaN.
  solicitation: 10,
  rfp: 20,
  proposal_pending_approval: 55,
  proposal_sent: 65,
  follow_up: 65,
  won: 100,
  lost: 0,
};

/** Sub-statuses where probability should be PRESERVED (not reset) when
 *  transitioning INTO them. Follow-Up is the classic "waiting on the
 *  customer" holding state — probability shouldn't drop. */
export const PROBABILITY_PRESERVING_SUB_STATUSES: ReadonlySet<string> = new Set([
  "follow_up",
  "wip_on_hold",
]);

/** v1.1 alias — kept during migration. */
export const PROBABILITY_PRESERVING_STATUSES: ReadonlySet<string> = new Set([
  "follow_up",
]);

// ═══════════════════════════════════════════════════════════════════
// Terminal & open
// ═══════════════════════════════════════════════════════════════════

/** The bid decision is settled. Sets `decided_at` on write. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "pre_sale_closed", // Lost bids stop here
  "post_sale_closed", // Delivered projects stop here
]);

/** Predicate form. Accepts unknown so callers don't have to type-narrow. */
export function isTerminalOpportunityStatus(
  status: string | null | undefined
): boolean {
  return (
    status !== null && status !== undefined && TERMINAL_STATUSES.has(status)
  );
}

// ═══════════════════════════════════════════════════════════════════
// Semantic tuple predicates — used everywhere v1 code compared to raw
// 'won' / 'lost' / 'follow_up' as a top-level status. In v2 those are
// sub-statuses under Closed / Proposal, so callers need to look at the
// tuple. Grep for `isWon(` etc. as the migration marker.
// ═══════════════════════════════════════════════════════════════════

type StatusTuple = {
  status: string | null | undefined;
  sub_status: string | null | undefined;
};

/** True when this opp is in Pre-Sale/Closed/Won. */
export function isWon(opp: StatusTuple): boolean {
  return opp.status === "pre_sale_closed" && opp.sub_status === "won";
}

/** True when this opp is in Pre-Sale/Closed/Lost. */
export function isLost(opp: StatusTuple): boolean {
  return opp.status === "pre_sale_closed" && opp.sub_status === "lost";
}

/** True when this opp is in Proposal/Follow Up (waiting on customer). */
export function isFollowUp(opp: StatusTuple): boolean {
  return opp.status === "proposal" && opp.sub_status === "follow_up";
}

/** True when the opp has been decided (Won OR Lost OR Closeout OR Closed). */
export function isDecided(opp: StatusTuple): boolean {
  return isWon(opp) || isLost(opp) || (opp.status === "post_sale_closed");
}

/** True when the opp is in the Post-Sale lane (project delivery phase). */
export function isPostSale(opp: StatusTuple): boolean {
  return opp.status ? !PRE_SALE_STATUS_SET.has(opp.status) : false;
}

/** Sub-statuses that count as "the opp is truly closed" — used by
 *  reporting to distinguish Won-and-billed vs Lost from Pre-Sale.Won-
 *  waiting-for-kickoff. */
export const FULLY_CLOSED_SUB_STATUSES: ReadonlySet<string> = new Set([
  "lost", // Pre-Sale/Closed/Lost
  "closed", // Post-Sale/Closed/Closed
]);

/** Statuses that count as "open" in pipeline reporting.
 *  Excludes terminal (pre_sale_closed=lost and post_sale_closed=closed).
 *  Pre-Sale/Closed/Won IS still "open" from a project-delivery perspective
 *  until Alex clicks Start Project. */
export const OPEN_OPP_STATUSES: readonly string[] = [
  "qualifying",
  "estimating",
  "proposal",
  "pre_construction",
  "in_progress",
  "billing",
] as const;

// ═══════════════════════════════════════════════════════════════════
// Status DAG
//
// v2: transitions defined at the STATUS level. Sub-status transitions
// within a status are always free (any → any within the parent's whitelist).
// ═══════════════════════════════════════════════════════════════════

// Karan 2026-07-15 (later): "take out all of these Can't move from X to Y
// directly — let me move the kanban freely." Real workflows have too
// many edge cases (Change Order reopens billing→in_progress, verbal-yes
// jumps qualifying→pre_construction, testing scenarios, mid-flight
// scope changes) for a strict DAG to protect anything real. The
// WARN_TRANSITIONS set below still tags the unusual jumps as
// "are-you-sure" soft warnings; the type enum still guards against
// junk statuses; but the flat "you can't do that" wall is gone.
//
// Every status can now transition to any other status. This map is
// kept as a mostly-informational surface so callers doing
// `allowedNextStatuses(status)` for UI purposes get every other
// status back (excluding self, which isn't a real transition).
/** Karan 2026-07-15 (round 5): real DAG, no longer any-to-any.
 *
 *  Rules:
 *   - Forward progression is always allowed (Qualifying → Estimating →
 *     Proposal → Won/Lost → Pre-Con → In Progress → Billing → Closed).
 *   - One-step backward within Pre-Sale is allowed for revision cycles
 *     (Proposal → Estimating for re-pricing; Estimating → Qualifying
 *     for scope reset).
 *   - Reopen from terminal is allowed (Won/Lost → Proposal, and
 *     Post-Sale Closed → Billing/In Progress for delivery reopen).
 *   - Skip-forward is allowed for early wins (Qualifying → Won for a
 *     verbal-yes repeat customer) and cancellations
 *     (any pre-sale → Lost).
 *   - Multi-step backward jumps are BLOCKED (In Progress → Estimating
 *     is nonsense — the crew is on site; use the proposals page or
 *     debrief flow if needed).
 *
 *  Note on sub-status: this map is top-level status only. Sub-status
 *  changes within the same top-level status (e.g. proposal/sent →
 *  proposal/follow_up) always bypass the DAG check — they're just
 *  refinements of the same stage.
 */
export const ALLOWED_TRANSITIONS: Record<string, ReadonlyArray<string>> = {
  qualifying: ["estimating", "proposal", "pre_sale_closed"],
  estimating: ["qualifying", "proposal", "pre_sale_closed"],
  proposal: ["estimating", "pre_sale_closed"],
  // Reopen: closed pre-sale can go back to any pre-sale stage OR
  // forward to pre-construction (Won deal starting delivery).
  pre_sale_closed: ["qualifying", "estimating", "proposal", "pre_construction"],
  pre_construction: ["in_progress", "billing", "post_sale_closed", "pre_sale_closed"],
  in_progress: ["pre_construction", "billing", "post_sale_closed"],
  billing: ["in_progress", "post_sale_closed"],
  // Reopen delivery: closed post-sale can go back to billing/in_progress.
  post_sale_closed: ["billing", "in_progress"],
};

/** Transitions that are technically allowed but unusual enough to
 *  deserve a soft warning in the UI. Keyed by `from→to`. */
export const WARN_TRANSITIONS: ReadonlySet<string> = new Set([
  // Early kill
  "qualifying→pre_sale_closed", // if sub is lost — verbal decline in Qualifying
  // Repeat-customer verbal-yes jumps
  "qualifying→pre_sale_closed", // if sub is won — no proposal cycle
  // Scope-change rebids
  "proposal→estimating",
  // Post-sale backpedals
  "in_progress→pre_construction",
  "billing→in_progress",
  // Terminal reopen
  "post_sale_closed→qualifying",
  "pre_sale_closed→qualifying",
  "pre_sale_closed→estimating",
  "pre_sale_closed→proposal",
]);

// ═══════════════════════════════════════════════════════════════════
// UI hints
// ═══════════════════════════════════════════════════════════════════

/** Statuses the list-page quick-flip dropdown should NOT expose.
 *  Terminal states need extra fields (loss_reason, decided_at) so
 *  the user must open the detail page. */
export const QUICK_FLIP_BLOCKED_STATUSES: ReadonlySet<string> = new Set([
  "pre_sale_closed",
  "post_sale_closed",
]);

// ═══════════════════════════════════════════════════════════════════
// Hot / stale / cooling constants (v2-adjusted)
// ═══════════════════════════════════════════════════════════════════

export const HOT_DEAL_BID_CENTS = 5_000_000; // $50,000
export const HOT_DEAL_DECISION_DAYS = 14;

/** "Hot deal" = active pre-sale bid with high $ + close decision date.
 *  Post-sale opps aren't "hot" in the sales sense — they're won already. */
export const HOT_DEAL_ACTIVE_STATUSES: readonly string[] = [
  "qualifying",
  "estimating",
  "proposal",
] as const;

export const STALE_OPP_DAYS = 14;
export const STALE_ACCOUNT_OPP_COOLING_MULTIPLIER = 4;
