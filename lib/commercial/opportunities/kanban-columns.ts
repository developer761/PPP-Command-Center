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
export const PRE_CONTRACT_COLUMNS: readonly KanbanColumn[] = [
  { key: "qualifying", label: "Qualifying", lane: "pre_contract" },
  { key: "rfp", label: "Request for Proposal", lane: "pre_contract" },
  { key: "estimating", label: "Estimating", lane: "pre_contract" },
  { key: "proposal", label: "Proposal", lane: "pre_contract" },
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
  "qualifying",
  "rfp",
  "estimating",
  "proposal",
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

export function isPreContractColumn(key: string): boolean {
  return COLUMN_BY_KEY.get(key)?.lane === "pre_contract";
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
      // RFP is promoted out of Qualifying into its own stage. The other
      // two subs (solicitation, estimating) stay under Qualifying.
      return sub_status === "rfp" ? "rfp" : "qualifying";
    case "estimating":
      // Priced-and-awaiting-sign-off reads as a Proposal to the sales
      // team even though the deal row still says `estimating`.
      return sub_status === "proposal_pending_approval"
        ? "proposal"
        : "estimating";
    case "proposal":
      // sent + follow_up both live here; follow_up shows as a card tag.
      return "proposal";
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
      return "qualifying";
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
 * Note `qualifying` targets `solicitation`, not `rfp` — dragging a deal
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
  qualifying: { status: "qualifying", sub_status: "solicitation" },
  rfp: { status: "qualifying", sub_status: "rfp" },
  estimating: { status: "estimating", sub_status: "estimating" },
  proposal: { status: "proposal", sub_status: "sent" },
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

/** The real top-level status behind a column key — used where a caller
 *  needs to compare against the status enum (validation, DAG hints). */
export function columnRealStatus(key: string): string {
  return COLUMN_TARGET[key]?.status ?? key;
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
  if (key === "proposal" || key === "qualifying") return null;
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
