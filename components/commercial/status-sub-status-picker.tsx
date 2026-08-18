"use client";

/**
 * Cascading (Status → Sub-Status → Follow-up) picker for Katie's v2
 * two-lane deal model (Phase E-4, 2026-07-13).
 *
 *   Top-level status  →  filters sub-status options
 *   Sub-status = "follow_up" or user-flagged  →  reveals follow_up_at + notes
 *
 * The picker renders the fields the server actions already parse:
 *   name="status" / name="to_status"     (top-level)
 *   name="sub_status" / name="to_sub_status"
 *   name="follow_up_at" / name="follow_up_notes"
 *
 * `mode` toggles between CREATE (accepts terminal-close block) and FLIP
 * (allows selecting terminal states so quick-flip can Close). CREATE
 * excludes pre_sale_closed + post_sale_closed because a brand-new deal
 * shouldn't start already-decided.
 */
import { useState } from "react";
import { DateField } from "@/components/commercial/date-field";
import {
  OPPORTUNITY_STATUSES,
  SUB_STATUSES_BY_STATUS,
  OFFERED_SUB_STATUSES,
  DEFAULT_SUB_STATUS_BY_STATUS,
  TERMINAL_STATUSES,
} from "@/lib/commercial/opportunities/constants";
import {
  PRE_CONTRACT_COLUMNS,
  POST_CONTRACT_COLUMNS,
  columnKeyForOpp,
  OPEN_COLUMN_KEYS,
  COLUMN_TARGET,
} from "@/lib/commercial/opportunities/kanban-columns";

const CREATE_ALLOWED_STATUSES = OPPORTUNITY_STATUSES.filter(
  (s) => !TERMINAL_STATUSES.has(s)
);

/**
 * The stages a BRAND-NEW opportunity can start at, as the flat pre-contract
 * lane Karan named in the 2026-08 meeting:
 *
 *   Qualifying · Request for Proposal · Estimating · Proposal
 *
 * Create mode used to offer the raw status enum minus terminals, which meant
 * a new opportunity's Status dropdown listed Pre-Construction, In Progress and
 * Billing — post-CONTRACT delivery stages, on a bid nobody has priced yet.
 * Karan's ask, verbatim: "Split up the Status by Pre-Contract and Post-
 * Contract — only display the ones that are relevant."
 *
 * Flat, so there's no second Sub-status dropdown to reason about at create
 * time: RFP is its own stage here, and the old sub-status choices under
 * Qualifying (Solicitation / RFP / Estimating) collapsed into it. Each option
 * carries the real (status, sub_status) tuple, posted as hidden fields, so
 * the server actions parse exactly what they always did.
 */
// "Proposal" is deliberately NOT offered at create time. Its tuple is
// (proposal, sent) — literally "the proposal is out with the GC" — so a
// brand-new deal picked it and immediately claimed a proposal had been sent
// that doesn't exist: an empty Proposals tab, the sent-stage probability (65%)
// inflating weighted pipeline on a deal thirty seconds old, and the page-load
// reconciler pulling the deal back because no sent proposal is there to
// justify it, so the stage didn't even stick.
//
// You can't have sent a proposal you haven't built. If one genuinely went out
// already, build it and hit Send — the deal advances to Proposal on its own,
// with an actual proposal behind it. (Karan 2026-08, option (a).)
// AUDIT 2026-08-12: this said ["proposal"], and that key stopped existing when
// the stage was renamed `sent` — so the guard silently switched off and BOTH
// "Sent" and "Pending Approval" became creatable. You cannot have sent, or be
// awaiting sign-off on, a proposal that does not exist; a deal created there
// would sit in a stage with nothing behind it and no way for the engine to
// reconcile it.
//
// Caught by the parallel session, which noted I had edited this file three
// times since the rename without fixing it.
const CREATE_EXCLUDED_STAGES: readonly string[] = ["sent", "pending_approval"];

const CREATE_STAGES = PRE_CONTRACT_COLUMNS.filter(
  (c) => OPEN_COLUMN_KEYS.includes(c.key) && !CREATE_EXCLUDED_STAGES.includes(c.key)
).map((c) => ({ key: c.key, label: c.label, target: COLUMN_TARGET[c.key] }));

/**
 * FLIP mode stages — the whole ladder, both lanes.
 *
 * AUDIT 2026-08-12. Create mode has offered a flat Stage select since it was
 * built; changing a status still asked for a top-level status AND a
 * sub-status. That is how you reach RFP by picking "Qualifying" again and
 * changing a second dropdown, and it is what Karan hit and what Brendan meant
 * by "we have a lot of duplicated, a lot of things are a bit confusing".
 *
 * One list, in order, writing the same tuple the server action already
 * expects — the identical pattern create mode uses.
 */
const FLIP_STAGES = [...PRE_CONTRACT_COLUMNS, ...POST_CONTRACT_COLUMNS]
  .filter((c) => COLUMN_TARGET[c.key])
  .map((c) => ({ key: c.key, label: c.label, target: COLUMN_TARGET[c.key], lane: c.lane }));

// Qualifying was retired 2026-08-16 (RFP is the entry stage), so its hint is
// gone with it — a hint for a stage nobody can select is a trap for the next
// person editing this map.
const CREATE_STAGE_HINT: Record<string, string> = {
  rfp: "An invitation to bid arrived. Sets the RFP-received date to today.",
  estimating: "We're putting a price together.",
};

export type StatusSubStatusPickerProps = {
  /** Field-name prefix. "" produces `status` / `sub_status`; "to_"
   *  produces `to_status` / `to_sub_status`. Matches the two server-
   *  action naming conventions in the codebase. */
  namePrefix?: "" | "to_";
  /** CREATE hides terminal top-level statuses so a brand-new deal
   *  can't start already-Won. FLIP allows all v2 statuses. */
  mode?: "create" | "flip";
  initialStatus?: string;
  initialSubStatus?: string | null;
  initialFollowUpAt?: string | null;
  initialFollowUpNotes?: string | null;
  /** When "flip", parent may want to restrict the top-level options
   *  (e.g., DAG-allowed next statuses). Empty array = show all. */
  allowedStatuses?: readonly string[] | null;
  /** Called when the top-level status changes — parent can react
   *  (e.g., decide whether to reveal terminal-only fields elsewhere). */
  onStatusChange?: (status: string) => void;
  /** Optional label overrides for legibility. */
  statusLabel?: string;
  subStatusLabel?: string;
  className?: string;
};

const INPUT_CLS =
  "w-full px-3 py-2 text-base sm:text-sm bg-surface border border-ppp-charcoal-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[44px]";
const SELECT_CLS = `${INPUT_CLS} appearance-none bg-surface bg-no-repeat pr-9`;
const LABEL_CLS = "block text-[13px] font-semibold text-ppp-charcoal-800 mb-1.5";
const HINT_CLS = "text-[11.5px] text-ppp-charcoal-500 mt-1";
// Inline chevron so the select's caret matches the rest of the platform.
const SELECT_BG_STYLE = {
  backgroundImage:
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 20 20' fill='none' stroke='%23475569' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M5 8l5 5 5-5'/></svg>\")",
  backgroundPosition: "right 0.75rem center",
  backgroundSize: "12px 12px",
};

export function StatusSubStatusPicker({
  namePrefix = "",
  mode = "flip",
  initialStatus,
  initialSubStatus,
  initialFollowUpAt,
  initialFollowUpNotes,
  allowedStatuses,
  onStatusChange,
  statusLabel = "Status",
  subStatusLabel = "Sub-status",
  className = "",
}: StatusSubStatusPickerProps) {
  // Field names — match what the server actions already parse.
  const statusField = `${namePrefix}status`;
  const subStatusField = `${namePrefix}sub_status`;

  // Build the base list of top-level statuses this picker offers.
  const baseStatusOptions =
    mode === "create" ? CREATE_ALLOWED_STATUSES : OPPORTUNITY_STATUSES;
  const statusOptions =
    allowedStatuses && allowedStatuses.length > 0
      ? baseStatusOptions.filter((s) => allowedStatuses.includes(s))
      : baseStatusOptions;

  const defaultStatus =
    initialStatus && (statusOptions as readonly string[]).includes(initialStatus)
      ? initialStatus
      : (statusOptions[0] as string) ?? "qualifying";

  const [status, setStatus] = useState<string>(defaultStatus);
  // Sub-status default: caller's value if valid for the picked status, else
  // the DEFAULT_SUB_STATUS_BY_STATUS entry for that status.
  // OFFERED, not merely valid. `qualifying` accepts an `estimating` sub-status
  // that means the same stage as the real Estimating — offering both is how a
  // person picks Estimating and watches the deal stay put. Old rows keep the
  // tuple; nobody can choose it again.
  const subOptionsForStatus =
    OFFERED_SUB_STATUSES[status] ??
    ((SUB_STATUSES_BY_STATUS as Record<string, readonly string[]>)[status] ?? []);
  const initialSubIsValid =
    initialSubStatus && subOptionsForStatus.includes(initialSubStatus);
  const [subStatus, setSubStatus] = useState<string>(
    initialSubIsValid
      ? (initialSubStatus as string)
      : (DEFAULT_SUB_STATUS_BY_STATUS as Record<string, string>)[status] ??
          subOptionsForStatus[0] ??
          ""
  );

  // Follow-up state — visible when the sub_status implies scheduling.
  // Katie's spec: proposal → follow_up is the canonical case. Also
  // reasonable for qualifying → rfp (waiting on the GC to release the
  // package), so we allow the user to opt in via a "Schedule follow-up"
  // toggle on non-follow_up sub-statuses. Auto-shown on follow_up.
  const isFollowUpSub = subStatus === "follow_up";
  const [followUpToggled, setFollowUpToggled] = useState<boolean>(
    Boolean(initialFollowUpAt) && !isFollowUpSub
  );
  const showFollowUp = isFollowUpSub || followUpToggled;

  // Create-mode stage state. Seeded from initialStatus when it maps onto one
  // of the four stages, so a caller that pre-selects "estimating" still lands
  // there.
  const [createStage, setCreateStage] = useState<string>(() => {
    const fromInitial = CREATE_STAGES.find((st) => st.key === initialStatus);
    // "rfp" is the entry stage, so it is also the last-resort fallback — the
    // old "qualifying" fallback names a stage that no longer exists.
    return fromInitial?.key ?? CREATE_STAGES[0]?.key ?? "rfp";
  });
  const createTarget =
    CREATE_STAGES.find((st) => st.key === createStage)?.target ??
    COLUMN_TARGET.qualifying;


  // CREATE: one flat Stage select over the pre-contract lane. See CREATE_STAGES.
  if (mode === "create") {
    return (
      <div className={`space-y-3 ${className}`}>
        <label className="block">
          <span className={LABEL_CLS}>Stage</span>
          <select
            value={createStage}
            onChange={(e) => setCreateStage(e.target.value)}
            className={SELECT_CLS}
            style={SELECT_BG_STYLE}
            aria-label="Stage"
            required
          >
            {CREATE_STAGES.map((st) => (
              <option key={st.key} value={st.key}>
                {st.label}
              </option>
            ))}
          </select>
          <p className={HINT_CLS}>
            {CREATE_STAGE_HINT[createStage] ?? "Where this opportunity starts."}
          </p>
        </label>
        {/* The real tuple the server action parses — unchanged contract. */}
        <input type="hidden" name={statusField} value={createTarget.status} />
        <input type="hidden" name={subStatusField} value={createTarget.sub_status} />
      </div>
    );
  }

  // FLIP: one flat Stage select, same as create mode. It used to be a
  // top-level status PLUS a sub-status, which is how you reached RFP by
  // choosing "Qualifying" again and changing a second dropdown — the exact
  // confusion Karan hit and Brendan described as "a lot of duplicated, a lot
  // of things are a bit confusing".
  const flipStage = columnKeyForOpp(status, subStatus);
  // Where the deal is RIGHT NOW, so the option that matches can say so.
  const currentStage = columnKeyForOpp(status, subStatus);
  // Picking a delivery stage on a deal that was never marked won. Real and
  // common (a verbal award), so this warns rather than refusing.
  const DELIVERY_KEYS = POST_CONTRACT_COLUMNS.map((c) => c.key);
  const jumpsToDelivery =
    DELIVERY_KEYS.includes(flipStage) &&
    !(initialStatus === "pre_sale_closed" || DELIVERY_KEYS.includes(columnKeyForOpp(initialStatus ?? "", initialSubStatus ?? null)));
  const setStage = (key: string) => {
    const t = COLUMN_TARGET[key];
    if (!t) return;
    setStatus(t.status);
    setSubStatus(t.sub_status);
    onStatusChange?.(t.status);
  };

  return (
    <div className={`space-y-3 ${className}`}>
      <label className="block">
        <span className={LABEL_CLS}>{statusLabel}</span>
        <select
          value={flipStage}
          onChange={(e) => setStage(e.target.value)}
          className={SELECT_CLS}
          style={SELECT_BG_STYLE}
          aria-label="Stage"
          required
        >
          <optgroup label="Sales">
            {FLIP_STAGES.filter((st) => st.lane === "pre_contract").map((st) => (
              // Katie 2026-08-13: the field said "Next status" and showed the
              // CURRENT one, because the current stage is in the list (you need
              // it to refine a sub-status in place). Marking it says which is
              // which instead of pre-picking a move nobody asked for.
              <option key={st.key} value={st.key}>{st.label}{st.key === currentStage ? " (current)" : ""}</option>
            ))}
          </optgroup>
          <optgroup label="Delivery">
            {FLIP_STAGES.filter((st) => st.lane === "post_contract").map((st) => (
              <option key={st.key} value={st.key}>{st.label}{st.key === currentStage ? " (current)" : ""}</option>
            ))}
          </optgroup>
        </select>
        <p className={HINT_CLS}>
          Most of these move on their own as proposals get built and sent.
        </p>
      </label>
      {/* Karan 2026-08-12: "it should let me jump into delivery if the opp
          hasn't been won yet and logic like that."
          
          A heads-up, not a block. A GC awards a job on the phone and the crew
          mobilises before any paperwork exists — refusing that would force
          people to lie to the system, and the platform's rule is warn, never
          reject. But jumping straight to delivery skips the win: no decision
          date, no Win/Loss debrief, and the job lands in delivery having never
          been counted as a sale. So we say exactly that, and let you through.
          
          The two-select UI showed this warning; the flat picker dropped it, and
          this is putting it back where it belongs — on the actual choice. */}
      {jumpsToDelivery && (
        <p className="text-[11.5px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2">
          <strong>Heads up</strong> — this job hasn&rsquo;t been marked won.
          Moving it straight into delivery records the win for you as of today,
          and skips the win/loss debrief. Mark it Closed Won first if the award
          date matters.
        </p>
      )}
      {/* The tuple the server action parses — unchanged contract, exactly as
          create mode already does it. */}
      <input type="hidden" name={statusField} value={status} />
      <input type="hidden" name={subStatusField} value={subStatus} />

      {/* Follow-up scheduling — auto-shown when sub_status is "follow_up",
          otherwise behind a small opt-in toggle so pre-sale bids can still
          have a "check back in 2 weeks" reminder even before they land in
          formal Proposal / Follow-up. */}
      {!isFollowUpSub && (
        <div>
          <button
            type="button"
            onClick={() => setFollowUpToggled((v) => !v)}
            className="text-[12px] font-medium text-cc-brand-700 hover:text-cc-brand-800 inline-flex items-center gap-1"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              {followUpToggled ? <path d="M5 12h14" /> : <><path d="M12 5v14" /><path d="M5 12h14" /></>}
            </svg>
            {followUpToggled ? "Skip follow-up" : "Add follow-up"}
          </button>
        </div>
      )}
      {showFollowUp && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-cc-brand-50/40 border border-cc-brand-100 rounded-lg p-3">
          <label className="block">
            <span className={LABEL_CLS}>Follow up on</span>
            <DateField
              name={`${namePrefix}follow_up_at`}
              defaultValue={initialFollowUpAt ?? ""}
              placeholder="Pick a date"
              className="mt-1"
            />
            <p className={HINT_CLS}>Shows up on the opportunity row until you touch it again.</p>
          </label>
          <label className="block sm:col-span-1">
            <span className={LABEL_CLS}>Follow-up notes</span>
            <input
              type="text"
              name={`${namePrefix}follow_up_notes`}
              defaultValue={initialFollowUpNotes ?? ""}
              maxLength={200}
              placeholder="e.g. Chase Anna re: revised price"
              className={INPUT_CLS}
            />
          </label>
        </div>
      )}
    </div>
  );
}

export default StatusSubStatusPicker;
