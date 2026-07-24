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
import {
  OPPORTUNITY_STATUSES,
  SUB_STATUSES_BY_STATUS,
  DEFAULT_SUB_STATUS_BY_STATUS,
  opportunityStatusLabelV2,
  opportunitySubStatusLabel,
  TERMINAL_STATUSES,
} from "@/lib/commercial/opportunities/constants";

const CREATE_ALLOWED_STATUSES = OPPORTUNITY_STATUSES.filter(
  (s) => !TERMINAL_STATUSES.has(s)
);

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
  "w-full px-3 py-2 text-base sm:text-sm bg-white border border-ppp-charcoal-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[44px]";
const SELECT_CLS = `${INPUT_CLS} appearance-none bg-white bg-no-repeat pr-9`;
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
  const subOptionsForStatus = (
    SUB_STATUSES_BY_STATUS as Record<string, readonly string[]>
  )[status] ?? [];
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

  const handleStatusChange = (next: string) => {
    setStatus(next);
    const nextSubs = (SUB_STATUSES_BY_STATUS as Record<string, readonly string[]>)[next] ?? [];
    // If the current sub_status isn't valid for the new status, reset it.
    if (!nextSubs.includes(subStatus)) {
      const nextDefault =
        (DEFAULT_SUB_STATUS_BY_STATUS as Record<string, string>)[next] ??
        nextSubs[0] ??
        "";
      setSubStatus(nextDefault);
    }
    onStatusChange?.(next);
  };

  return (
    <div className={`space-y-3 ${className}`}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={LABEL_CLS}>{statusLabel}</span>
          <select
            name={statusField}
            value={status}
            onChange={(e) => handleStatusChange(e.target.value)}
            className={SELECT_CLS}
            style={SELECT_BG_STYLE}
            required
          >
            {statusOptions.map((s) => (
              <option key={s} value={s}>
                {opportunityStatusLabelV2(s)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={LABEL_CLS}>{subStatusLabel}</span>
          <select
            name={subStatusField}
            value={subStatus}
            onChange={(e) => setSubStatus(e.target.value)}
            className={SELECT_CLS}
            style={SELECT_BG_STYLE}
            required
          >
            {subOptionsForStatus.map((s) => (
              <option key={s} value={s}>
                {opportunitySubStatusLabel(s)}
              </option>
            ))}
          </select>
          <p className={HINT_CLS}>
            {status === "proposal"
              ? "Proposal Sent = quote out with the GC. Follow Up = we're chasing them."
              : status === "qualifying"
              ? "Solicitation = they invited a bid. RFP = formal package landed. Estimating = we're putting a price together."
              : status === "estimating"
              ? "Estimating = we're pricing. Proposal Pending Approval = priced, waiting on internal sign-off."
              : status === "in_progress"
              ? "WIP On Site = crew is actively painting. WIP On Hold = paused (weather, access, GC change order, etc.)."
              : status === "billing"
              ? "Substantial Completion = walkthrough done. Completed and Invoiced = final invoice out."
              : status === "post_sale_closed"
              ? "Completed / Close-Out Docs = O&M / warranty / attic stock pending. Closed = fully done."
              : "Where this deal sits inside the lane."}
          </p>
        </label>
      </div>

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
            {followUpToggled ? "Skip follow-up reminder" : "Schedule a follow-up reminder"}
          </button>
        </div>
      )}
      {showFollowUp && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-cc-brand-50/40 border border-cc-brand-100 rounded-lg p-3">
          <label className="block">
            <span className={LABEL_CLS}>Follow up on</span>
            <input
              type="date"
              name={`${namePrefix}follow_up_at`}
              defaultValue={initialFollowUpAt ?? ""}
              className={INPUT_CLS}
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
