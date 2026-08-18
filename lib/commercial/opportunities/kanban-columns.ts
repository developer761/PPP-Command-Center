/**
 * Kanban / "Move to…" VISUAL COLUMNS — the display layer over the
 * two-level (status, sub_status) tuple defined in ./constants.ts.
 *
 * Karan 2026-08 meeting: the pre-contract lane should read as six flat
 * stages, the words the team actually says out loud:
 *
 *   Qualifying · Request for Proposal · Estimating · Proposal ·
 *   Closed Won · Closed Lost
 *
 * The DATA MODEL is unchanged — no migration. RFP already exists as a
 * sub-status of `qualifying`; "Proposal Drafted" was only ever the
 * (estimating, proposal_pending_approval) tuple wearing a costume. So
 * this module does two things and nothing else:
 *
 *   1. `columnKeyForOpp(status, sub_status)` — where a deal SHOWS.
 *      Total function: every valid tuple lands in exactly one column,
 *      and no tuple lands in two. (The old inline bucketer in
 *      app/commercial/opportunities/page.tsx silently dropped a deal
 *      whose status wasn't in its column list.)
 *
 *   2. `COLUMN_TARGET[key]` — the tuple a DROP on that column writes.
 *      Every target is whitelisted by SUB_STATUSES_BY_STATUS, so a drop
 *      can never violate the DB CHECK from migration 052/053.
 *
 * Both directions live HERE, together, on purpose: they used to be
 * duplicated across page.tsx (bucketer + quick-flip action), the
 * accounts page, and components/commercial-kanban-dnd.tsx, which is how
 * the two Proposal columns drifted apart in the first place. Any future
 * column change is a one-file edit.
 *
 * What deliberately did NOT become a column:
 *   - `proposal_pending_approval` — internal Kim→Brendan sign-off. That
 *     lives on the PROPOSAL record, not the deal. Deals sitting there
 *     display under Proposal.
 *   - `follow_up` — a state of a sent proposal, not a stage of its own.
 *     Rendered as a tag on the card inside the Proposal column.
 */

import {
  OPPORTUNITY_STATUSES,
  SUB_STATUSES_BY_STATUS,
  isValidSubStatus,
  opportunityStatusLabelV2,
  type OpportunityStatus,
} from "./constants";

// ═══════════════════════════════════════════════════════════════════
// Column definitions
// ═══════════════════════════════════════════════════════════════════

export type KanbanColumn = {
  /** Stable key used as the drop-target id and the Move-to form value. */
  key: string;
  label: string;
  lane: "pre_contract" | "post_contract";
};

/** Pre-contract lane — what Karan named in the 2026-08 meeting, in order.
 *  Closed Won / Closed Lost sit BETWEEN the pre- and post-contract
 *  stages: winning a bid is the last pre-contract event, and every
 *  post-contract stage is downstream of it. */
/*
 * Brendan 2026-08-12, verbatim: "The first stage in an opp should be RFP. Then
 * estimating — this should trigger when we assign the estimator. Then pending
 * approval — when the estimator submits for approval. Then sent. Then closed,
 * won or lost."
 *
 * This list IS that ladder, with Qualifying kept at the front (Karan's call —
 * Brendan wanted it moved to a separate lead flow, which is deferred).
 *
 * Two changes from what was here before, and they are the fix for "when I put
 * in sub status estimating it doesn't move the progress bar whatsoever":
 *   - Pending Approval is its own stage. It was folded into "Proposal", so a
 *     deal moving from pricing to awaiting-sign-off changed nothing on screen.
 *   - "Proposal" is now "Sent", which is what it means and what Brendan calls
 *     it. A stage named after the artifact, not the act, reads as a place a
 *     proposal lives rather than a thing that happened.
 *
 * Solicitation and Follow-Up are gone as visible stages (Brendan: drop them).
 * They still EXIST as stored sub-statuses on old rows — nothing is migrated,
 * nothing is lost — they simply fold into Qualifying and Sent below.
 */
export const PRE_CONTRACT_COLUMNS: readonly KanbanColumn[] = [
  // "Qualifying" retired 2026-08-17 (Brendan) — an opportunity starts at
  // RFP. The key itself stays defined below so legacy rows and any stored
  // filter that still names it keep resolving instead of crashing.
  { key: "rfp", label: "RFP", lane: "pre_contract" },
  { key: "estimating", label: "Estimating", lane: "pre_contract" },
  { key: "pending_approval", label: "Pending Approval", lane: "pre_contract" },
  { key: "sent", label: "Sent", lane: "pre_contract" },
  { key: "won", label: "Closed Won", lane: "pre_contract" },
  { key: "lost", label: "Closed Lost", lane: "pre_contract" },
] as const;

/** Post-contract lane — the delivery tree. Unchanged; it already matched
 *  Karan's spec exactly (Pre-Construction → In Progress → Billing →
 *  Closed), so there was nothing to flatten here. */
export const POST_CONTRACT_COLUMNS: readonly KanbanColumn[] = [
  { key: "pre_construction", label: "Pre-Construction", lane: "post_contract" },
  { key: "in_progress", label: "In Progress", lane: "post_contract" },
  { key: "billing", label: "Billing", lane: "post_contract" },
  { key: "post_sale_closed", label: "Completed", lane: "post_contract" },
] as const;

export const KANBAN_COLUMNS: readonly KanbanColumn[] = [
  ...PRE_CONTRACT_COLUMNS,
  ...POST_CONTRACT_COLUMNS,
] as const;

/** Columns that hold ACTIVE work — the ones rendered as drop zones in the
 *  board's open strip. Won/Lost/Closed render as the terminal cluster
 *  with their own display cap, so they're excluded here. */
export const OPEN_COLUMN_KEYS: readonly string[] = [
  "rfp",
  "estimating",
  "pending_approval",
  "sent",
  "pre_construction",
  "in_progress",
  "billing",
] as const;

/**
 * The DECIDED cluster — deals that are finished, one way or another.
 *
 * post_sale_closed joins Won/Lost here rather than becoming a fourth top-level
 * column, for three reasons the board makes obvious:
 *   - `anyOnBoard` is computed only from the bucketed columns, so seeding a new
 *     open column would flip it true for every fully-closed account and render
 *     seven EMPTY columns beside one populated — verbatim the "wall of empty
 *     columns" the account filter exists to prevent.
 *   - The cluster already applies TERMINAL_DISPLAY_CAP; a new column would list
 *     every completed job a customer has ever had, unbounded.
 *   - The cluster is already titled "Closed". A separate column also called
 *     Closed would put two of them on one board, next to "Closed Won" and
 *     "Closed Lost" — four things sharing a word.
 *
 * Labelled "Completed" inside the cluster so the three read as outcomes:
 * Won · Lost · Completed.
 */
export const TERMINAL_COLUMN_KEYS: readonly string[] = ["won", "lost", "post_sale_closed"] as const;

const COLUMN_BY_KEY = new Map(KANBAN_COLUMNS.map((c) => [c.key, c]));

export function kanbanColumnLabel(key: string): string {
  return COLUMN_BY_KEY.get(key)?.label ?? key;
}

/**
 * Label for a "Move to…" menu option. Same as kanbanColumnLabel except the
 * post-contract Closed column, which is disambiguated: a menu that lists
 * "Closed Won · Closed Lost · … · Closed" reads as three closed states with
 * no way to tell the last one apart. On the BOARD the column sits visibly
 * inside the delivery lane, so the bare label is fine there.
 *
 * Exists because the pipeline page hand-rolled this exception and the
 * accounts page didn't, so the same key showed two different names.
 */
export function kanbanMoveToLabel(key: string): string {
  if (key === "post_sale_closed") return "Closed (post-sale)";
  return kanbanColumnLabel(key);
}

// ═══════════════════════════════════════════════════════════════════
// Tuple → column (where a deal SHOWS)
// ═══════════════════════════════════════════════════════════════════

/**
 * Which visual column does this (status, sub_status) tuple live in?
 *
 * TOTAL over the eight real statuses — every deal lands somewhere, so
 * the board can never silently swallow a card. An unrecognised status
 * (a legacy v1 row that escaped migration 052, say) falls back to
 * Qualifying rather than vanishing: a deal in the wrong column is a
 * visible, fixable problem; a deal in NO column is an invisible one.
 */
export function columnKeyForOpp(
  status: string | null | undefined,
  sub_status: string | null | undefined
): string {
  switch (status) {
    case "qualifying":
      // AUDIT 2026-08-12 (Karan: "I put it into estimating and it brings it
      // back to qualifying"). `qualifying` carries an `estimating` SUB-status,
      // so there were two different tuples both meaning "we are pricing it":
      // (qualifying, estimating) and (estimating, estimating). This mapper only
      // promoted `rfp`, so the first one read as Qualifying — picking Estimating
      // genuinely sent the deal backwards on screen.
      //
      // Both tuples now resolve to the stage the words mean. The picker no
      // longer OFFERS the qualifying variant (see OFFERED_SUB_STATUSES), so no
      // new ones are created; this keeps the old rows reading correctly.
      if (sub_status === "estimating") return "estimating";
      // Everything else in this lane — including legacy `solicitation` and a
      // null sub-status — now reads as RFP. The Qualifying column is gone, so
      // returning it would put rows on a board column that no longer renders.
      return "rfp";
    case "estimating":
      // Awaiting sign-off is its OWN stage now, not a fold into Proposal —
      // that fold is why moving a deal from pricing to pending-approval left
      // the progress bar untouched.
      return sub_status === "proposal_pending_approval"
        ? "pending_approval"
        : "estimating";
    case "proposal":
      // Follow-Up is dropped as a stage (Brendan): chasing a GC is still the
      // proposal being out, not a different place in the pipeline. Old rows
      // carrying it fold in here rather than being migrated.
      return "sent";
    case "pre_sale_closed":
      // Defaults to LOST, not Won. sub_status has no CHECK constraint
      // behind it any more (migration 059 dropped both), so a hand-edited
      // or legacy row can carry junk here — and a junk row rendering as a
      // WIN silently inflates the board and every won-deal rollup. A
      // stray Lost is visible and harmless by comparison.
      return sub_status === "won" ? "won" : "lost";
    case "pre_construction":
    case "in_progress":
    case "billing":
    case "post_sale_closed":
      return status;
    default:
      // Fallback for an unrecognised or null status. RFP is the lane's entry
      // column now that Qualifying is retired, so junk lands there rather than
      // on a column the board no longer renders (which would drop the card).
      return "rfp";
  }
}

/** True when the card should carry a "Follow-Up" tag — it's a sent
 *  proposal we're chasing, sharing the Proposal column with fresh ones. */
export function isFollowUpCard(
  status: string | null | undefined,
  sub_status: string | null | undefined
): boolean {
  return status === "proposal" && sub_status === "follow_up";
}

/** True when the card is a proposal that hasn't gone out to the GC yet
 *  (priced, pending internal approval). Also shares the Proposal column. */
export function isDraftedCard(
  status: string | null | undefined,
  sub_status: string | null | undefined
): boolean {
  return status === "estimating" && sub_status === "proposal_pending_approval";
}

// ═══════════════════════════════════════════════════════════════════
// Column → tuple (what a DROP writes)
// ═══════════════════════════════════════════════════════════════════

export type ColumnTarget = {
  status: OpportunityStatus;
  /** Always an explicit, whitelisted sub-status — never left to the
   *  DEFAULT_SUB_STATUS_BY_STATUS fallback, so the write is predictable
   *  and the DB CHECK can't be violated. */
  sub_status: string;
};

/**
 * The (status, sub_status) a drop on each column writes.
 *
 * NOTE: `qualifying` is no longer a drop target (Brendan 2026-08-17) — the
 * lane's only column is RFP. Historic note kept for context:
 * Note `qualifying` targeted `solicitation`, not `rfp` — dragging a deal
 * BACK to Qualifying from RFP has to actually leave the RFP column, and
 * solicitation is the natural entry point of that stage.
 *
 * `proposal` targets (proposal, sent) rather than preserving a card's
 * follow_up/drafted sub. Dropping a card INTO Proposal is the user
 * saying "this is a live proposal now"; if they wanted Follow-Up they
 * set it on the deal.
 *
 * That makes these targets LOSSY for cards already in the column, so
 * every caller must skip the write when the card's current column equals
 * the drop target — otherwise a jittery drag inside the Proposal column
 * rewrites (proposal, follow_up) → (proposal, sent) and the Follow-Up tag
 * vanishes. changeOpportunityStatus can't catch that for us: it only
 * no-ops on an exact tuple match, and the tuples differ. The Move-to
 * dropdowns handle it by omitting the current column from the option
 * list; the drag-and-drop API handles it with an explicit guard.
 */
export const COLUMN_TARGET: Record<string, ColumnTarget> = {
  rfp: { status: "qualifying", sub_status: "rfp" },
  estimating: { status: "estimating", sub_status: "estimating" },
  // The two stages Brendan asked to split apart. Both write a real tuple, so
  // picking a stage sets status AND sub in one move — no second dropdown.
  pending_approval: { status: "estimating", sub_status: "proposal_pending_approval" },
  sent: { status: "proposal", sub_status: "sent" },
  won: { status: "pre_sale_closed", sub_status: "won" },
  lost: { status: "pre_sale_closed", sub_status: "lost" },
  pre_construction: { status: "pre_construction", sub_status: "coordination" },
  in_progress: { status: "in_progress", sub_status: "wip_on_site" },
  billing: { status: "billing", sub_status: "substantial_completion" },
  post_sale_closed: { status: "post_sale_closed", sub_status: "closeout" },
};

/**
 * Resolve a column key (or a raw status, for legacy callers still posting
 * "pre_sale_closed") into the tuple to write. Returns null for anything
 * unrecognised so callers surface a clean error instead of writing junk.
 */
export function resolveColumnTarget(key: string): ColumnTarget | null {
  const direct = COLUMN_TARGET[key];
  if (direct) return direct;
  // Legacy/raw-status callers: accept a bare REAL status and pick its
  // column's target. Two refusals, both deliberate:
  //
  //   - `pre_sale_closed` alone is ambiguous (won vs lost). The old code
  //     silently defaulted it to Won, which read to Alex as "nothing
  //     happened" — and skipped every won-drop side effect.
  //   - Anything not in the status enum. columnKeyForOpp is TOTAL (it
  //     defaults unknown input to Qualifying) which is right for
  //     DISPLAYING a junk row, but catastrophic for a WRITE: a typo'd or
  //     forged to_status would quietly move the deal to Qualifying
  //     instead of erroring. Resolution must be strict where display is
  //     forgiving.
  if (key === "pre_sale_closed") return null;
  if (!(OPPORTUNITY_STATUSES as readonly string[]).includes(key)) return null;
  return COLUMN_TARGET[columnKeyForOpp(key, null)] ?? null;
}

/**
 * The single real status a column can be pre-narrowed to in a DB query,
 * or null when the column spans more than one and the query must fetch
 * wider and filter in memory.
 *
 * Only Proposal spans two: it holds both (proposal, *) and the
 * priced-but-not-yet-sent (estimating, proposal_pending_approval).
 * Qualifying and Request for Proposal share `qualifying`, which is fine —
 * this is a NARROWING hint, not the filter itself. Callers must still
 * apply columnKeyForOpp to the rows that come back, or a Qualifying
 * filter will show RFP deals too.
 */
export function columnDbStatusHint(key: string): string | null {
  // Proposal spans two statuses. Qualifying is the fallback column for any
  // UNRECOGNISED status (columnKeyForOpp is total), so narrowing it with
  // .eq("status","qualifying") would hide exactly the rows that fallback
  // exists to rescue: a legacy v1 row that escaped migration 052 shows in
  // Qualifying on the open board, then vanishes the moment you filter to
  // Qualifying. Fetch wide for both and let the in-memory filter decide.
  // `sent` spans proposal/sent + the legacy proposal/follow_up rows, and
  // `pending_approval` shares the `estimating` status with `estimating` itself,
  // so neither can be narrowed to one status server-side.
  // `sent` spans proposal/sent + the legacy proposal/follow_up rows;
  // `pending_approval` shares the `estimating` status with `estimating`; and
  // `estimating` itself now holds BOTH (estimating, estimating) and the legacy
  // (qualifying, estimating) — narrowing it to one status would silently drop
  // the second, which is the row Karan hit. RFP is now the fallback column for
  // unrecognised/null statuses (Qualifying retired 2026-08-17), so narrowing IT
  // hides the rows that fallback exists to rescue. All four fetch wide and
  // filter in memory.
  if (key === "sent" || key === "pending_approval" || key === "estimating" || key === "rfp") {
    return null;
  }
  return COLUMN_TARGET[key]?.status ?? null;
}

// ═══════════════════════════════════════════════════════════════════
// Self-check
// ═══════════════════════════════════════════════════════════════════

/**
 * Every COLUMN_TARGET tuple must be whitelisted by SUB_STATUSES_BY_STATUS
 * (which mirrors the migration 052/053 CHECK constraint), and every valid
 * tuple in the whitelist must land in a real column. Exported so the test
 * suite asserts it; a drift here is a 500 on drag-and-drop.
 */
export function auditKanbanColumnMap(): string[] {
  const problems: string[] = [];
  for (const [key, target] of Object.entries(COLUMN_TARGET)) {
    if (!isValidSubStatus(target.status, target.sub_status)) {
      problems.push(
        `COLUMN_TARGET["${key}"] writes (${target.status}, ${target.sub_status}) which is not whitelisted.`
      );
    }
    if (columnKeyForOpp(target.status, target.sub_status) !== key) {
      problems.push(
        `COLUMN_TARGET["${key}"] writes a tuple that displays in column "${columnKeyForOpp(target.status, target.sub_status)}" — drop and land disagree.`
      );
    }
  }
  for (const [status, subs] of Object.entries(SUB_STATUSES_BY_STATUS)) {
    for (const sub of subs as readonly string[]) {
      const col = columnKeyForOpp(status, sub);
      if (!COLUMN_BY_KEY.has(col)) {
        problems.push(`(${status}, ${sub}) maps to unknown column "${col}".`);
      }
    }
  }
  return problems;
}

// ── Deal-page tabs by contract phase (Katie 2026-08) ───────────────────────

/**
 * Which tabs the deal page shows, by phase. Katie's note, verbatim:
 *   "Pre-Contract Tabs should be different from Post-Contract Tabs.
 *    Pre Contract = Proposals, Documents.
 *    Post Contract = Submittals, Invoices, Work Orders, Change Orders,
 *    AIA Billing, P&L, Closeout & Warranty, Costs."
 *
 * Pure and exported so it can be TESTED — the page composed these inline, so
 * nothing stopped the two lists drifting apart from Katie's spec over time.
 *
 * `isPostContract` is deliberately `isPostSaleProject` (true from the moment a
 * deal is WON), not the finer 4-way `dealPhase`. A won job needs its Submittals
 * and Work Orders immediately, before anything is billed — so tools follow the
 * CONTRACT, while the Overview's money tiles follow the finer phase. That
 * divergence is intentional.
 */
export const DEAL_PRIMARY_TABS_PRE: readonly { key: string; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "proposals", label: "Proposals" },
  { key: "documents", label: "Documents" },
] as const;

export const DEAL_PRIMARY_TABS_POST: readonly { key: string; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "proposals", label: "Proposals" },
  { key: "invoices", label: "Invoices" },
  { key: "pnl", label: "P&L" },
  { key: "documents", label: "Documents" },
] as const;

/** The six delivery tools — post-contract only. Same order + labels as the
 *  sidebar's "Delivery Tools" group so the two surfaces read identically. */
export const DEAL_DELIVERY_TOOLS: readonly { key: string; label: string }[] = [
  { key: "work-order", label: "Work Order" },
  { key: "submittals", label: "Submittals" },
  { key: "change-orders", label: "Change Orders" },
  { key: "aia", label: "AIA Billing" },
  { key: "costs", label: "Transactions" },
  { key: "closeout", label: "Closeout & Warranty" },
] as const;

export function dealTabsFor(isPostContract: boolean): {
  primary: readonly { key: string; label: string }[];
  tools: readonly { key: string; label: string }[];
} {
  return isPostContract
    ? { primary: DEAL_PRIMARY_TABS_POST, tools: DEAL_DELIVERY_TOOLS }
    : { primary: DEAL_PRIMARY_TABS_PRE, tools: [] };
}


/**
 * What to CALL the state a deal is in — the stage, in the words the pipeline,
 * the filters and the reports already use.
 *
 * AUDIT 2026-08-12 (Karan: "I put the status to RFP and it always says Status
 * updated to Qualifying"). This lived in constants.ts, returned the TOP-LEVEL
 * status and ignored the sub-status — so RFP read as "Qualifying" and Pending
 * Approval read as "Estimating", across 37 call sites including every
 * status-change confirmation. The message was true about a field nobody thinks
 * in, which is the same two-ladder problem as the progress bar.
 *
 * It lives here now because this is where the stage names are, and it uses the
 * same mapper as everything else — so a confirmation cannot disagree with the
 * bar the person is looking at.
 */
export function oppStatusDisplayLabel(
  status: string | null | undefined,
  sub_status: string | null | undefined
): string {
  // "Closed Won" / "Closed Lost" name the COLUMN — the bucket a deal falls
  // into. The deal itself says "Won" / "Lost": on a decided deal the outcome
  // is the useful word, and it is deliberate (pinned in kanban-columns.test).
  // Everything else takes its name straight from its column.
  if (status === "pre_sale_closed") {
    if (sub_status === "won") return "Won";
    if (sub_status === "lost") return "Lost";
  }
  if (!status) return opportunityStatusLabelV2(status);
  return kanbanColumnLabel(columnKeyForOpp(status, sub_status ?? null)) || opportunityStatusLabelV2(status);
}

/**
 * Which STATUS backs each stage on the progress bar.
 *
 * Needed because the status log records `to_status` and nothing else — a
 * sub-status move (Qualifying → RFP, Estimating → Pending Approval) leaves no
 * row at all. So the log can prove a whole status was never entered, but it
 * can never prove a sub-stage within one was skipped.
 */
const STATUS_BEHIND_STAGE: Record<string, string> = {
  qualifying: "qualifying",
  rfp: "qualifying",
  estimating: "estimating",
  pending_approval: "estimating",
  sent: "proposal",
  won: "pre_sale_closed",
  lost: "pre_sale_closed",
  pre_construction: "pre_construction",
  in_progress: "in_progress",
  billing: "billing",
  post_sale_closed: "post_sale_closed",
};

/**
 * Stages this deal demonstrably never sat in — the ones the progress bar
 * should mark "skipped" rather than tick as completed work.
 *
 * The bug: `stateFor` only ever returned passed/current/future, so a deal
 * dragged straight from RFP to Sent showed Estimating and Pending Approval
 * with completion ticks. The bar claimed work nobody did, on the one screen
 * people read to find out what has been done.
 *
 * Two deliberate refusals to guess:
 *
 *  - **No log, no claim.** A deal predating status logging returns nothing.
 *    Marking every earlier stage "skipped" because we have no record would
 *    trade over-claiming for accusing, which is worse.
 *  - **Sub-stages are never accused.** If a deal's status log shows it was
 *    `qualifying`, neither Qualifying nor RFP is marked, because nothing
 *    recorded which of the two it sat in. Only a status absent from the log
 *    ENTIRELY proves its stages were jumped.
 *
 * Pure, so the rule is testable without a database.
 */
export function skippedStages(
  stageKeys: readonly string[],
  log: readonly { from_status?: string | null; to_status: string }[]
): string[] {
  if (log.length === 0) return [];
  const seen = new Set<string>();
  for (const row of log) {
    seen.add(row.to_status);
    // The first entry's `from_status` is where the deal started, and it is the
    // only evidence of a status the deal held before anything was logged.
    if (row.from_status) seen.add(row.from_status);
  }
  return stageKeys.filter((k) => {
    const backing = STATUS_BEHIND_STAGE[k];
    return backing !== undefined && !seen.has(backing);
  });
}

/**
 * What each stage MEANS — the line that decides when to move a deal.
 *
 * Karan 2026-08-13: *"write what is considered as pre-construction, in
 * progress etc, so we know when the status bar should update."*
 *
 * A stage ladder without definitions is a ladder everyone climbs differently:
 * one person marks In Progress when the job is scheduled, another when the
 * crew arrives, and the billing report quietly compares the two. These are the
 * lines, phrased as the event that triggers the move.
 *
 * Rendered as tooltips on the progress bar and as the legend under the
 * delivery checklist, so the definition sits where the decision is made.
 */
export const STAGE_MEANING: Record<string, string> = {
  qualifying: "A lead worth looking at. Nothing has been asked of us yet.",
  rfp: "The bid package has arrived — plans, specs, a due date.",
  estimating: "Someone is pricing it. Move here when an estimator picks it up.",
  pending_approval: "Priced and waiting on internal sign-off before it goes out.",
  sent: "The proposal is with the GC. Nothing left to do but chase it.",
  won: "They said yes. The contract value is what the accepted proposal says.",
  lost: "They said no, or went elsewhere. Capture the reason — it is the report.",
  pre_construction:
    "Won and getting ready: submittals to the GC, the work order written, the crew scheduled. Nobody is on site yet.",
  in_progress:
    "The crew is on site and working. Move here the day work actually starts, not the day it was scheduled.",
  billing:
    "Field work is substantially complete and what is left is money — final applications, retainage, the last payments.",
  post_sale_closed:
    "Closed out: punchlist signed off, warranty issued, final payment and retainage received. Nothing outstanding.",
};
