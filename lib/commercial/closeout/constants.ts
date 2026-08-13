/**
 * Closeout & Warranty constants (Phase — post-contract tail). Client-safe: no
 * server imports, so the UI + pure math can be unit-tested without a DB.
 */

export const CLOSEOUT_STATUSES = ["draft", "sent", "acknowledged", "complete", "voided"] as const;
export type CloseoutStatus = (typeof CLOSEOUT_STATUSES)[number];

export const CLOSEOUT_STATUS_META: Record<
  CloseoutStatus,
  { label: string; tone: "charcoal" | "ppp-blue" | "emerald" | "rose" }
> = {
  draft: { label: "Draft", tone: "charcoal" },
  sent: { label: "Sent", tone: "ppp-blue" },
  acknowledged: { label: "Acknowledged", tone: "ppp-blue" },
  complete: { label: "Complete", tone: "emerald" },
  voided: { label: "Voided", tone: "rose" },
};

/** DAG. draft → sent → acknowledged → complete; any non-terminal → voided. */
export const ALLOWED_CLOSEOUT_TRANSITIONS: Record<CloseoutStatus, ReadonlyArray<CloseoutStatus>> = {
  draft: ["sent", "voided"],
  sent: ["acknowledged", "complete", "voided"],
  acknowledged: ["complete", "voided"],
  complete: [], // terminal
  voided: [], // terminal
};

export const TERMINAL_CLOSEOUT_STATUSES: ReadonlySet<CloseoutStatus> = new Set(["complete", "voided"]);

/** A sent/complete package is issued — its cover + the item SET (add/remove,
 *  kind, included) lock on send, like a submittal / AIA app. Only a draft is
 *  freely editable. */
export function isCloseoutEditable(status: CloseoutStatus): boolean {
  return status === "draft";
}

/** The Received / N-A collection status on an EXISTING checklist item is a
 *  LIVE working checklist: you transmit the package, THEN collect the docs and
 *  tick them off — right up until the package is complete/voided. So the item
 *  status (+ its attached doc / notes) stays editable through sent/acknowledged
 *  even though the cover + item set are locked. (2026-07-29: fixes the flow
 *  where "Mark sent" froze the checklist exactly when you'd start using it.) */
export function isCloseoutItemStatusEditable(status: CloseoutStatus): boolean {
  return !TERMINAL_CLOSEOUT_STATUSES.has(status);
}

export const CLOSEOUT_ITEM_KINDS = [
  "as_built",
  "om_manual",
  "warranty",
  "lien_waiver",
  "final_invoice",
  "punchlist_signoff",
  "coi",
  "other",
] as const;
export type CloseoutItemKind = (typeof CLOSEOUT_ITEM_KINDS)[number];

export const CLOSEOUT_ITEM_KIND_LABEL: Record<CloseoutItemKind, string> = {
  as_built: "As-built drawings",
  om_manual: "O&M manuals",
  warranty: "Warranty letter",
  lien_waiver: "Lien / final waiver",
  final_invoice: "Final invoice",
  punchlist_signoff: "Punchlist sign-off",
  coi: "Certificate of Insurance",
  other: "Other",
};

/**
 * The standard close-out checklist seeded on a new package.
 *
 * Katie: "REMOVE COI from the LoT (closeout cover letter)." A Certificate of
 * Insurance is a PRE-construction document — the GC has it before anyone sets
 * foot on site — so seeding it into the close-out checklist meant every
 * package opened with a row that was already satisfied months earlier, and
 * someone had to mark it N/A on every job to clear the list.
 *
 * `coi` stays in CLOSEOUT_ITEM_KINDS: packages created before this still carry
 * the row, and it must keep its label rather than rendering as "Other". It is
 * simply no longer seeded, and no longer offered as an addable kind.
 */
export const DEFAULT_CLOSEOUT_ITEMS: ReadonlyArray<{ kind: CloseoutItemKind }> = [
  { kind: "punchlist_signoff" },
  { kind: "as_built" },
  { kind: "om_manual" },
  { kind: "warranty" },
  { kind: "lien_waiver" },
  { kind: "final_invoice" },
];

/** Kinds a person may ADD to a package. `coi` is excluded — see above. */
export const ADDABLE_CLOSEOUT_ITEM_KINDS = CLOSEOUT_ITEM_KINDS.filter(
  (k) => k !== "coi"
);

export const CLOSEOUT_ITEM_STATUSES = ["pending", "received", "na"] as const;
export type CloseoutItemStatus = (typeof CLOSEOUT_ITEM_STATUSES)[number];

export const CLOSEOUT_ITEM_STATUS_LABEL: Record<CloseoutItemStatus, string> = {
  pending: "Pending",
  received: "Received",
  na: "N/A",
};

/** Transmitted-as radio (mirrors submittals). */
export const CLOSEOUT_TRANSMITTED_AS = [
  "for_approval",
  "for_your_records",
  "as_requested",
  "for_review",
] as const;
export type CloseoutTransmittedAs = (typeof CLOSEOUT_TRANSMITTED_AS)[number];

export const CLOSEOUT_TRANSMITTED_AS_LABEL: Record<CloseoutTransmittedAs, string> = {
  for_approval: "For approval",
  for_your_records: "For your records",
  as_requested: "As requested",
  for_review: "For review",
};

/** Warranty end = substantial-completion + N years (DATE-only, no TZ drift).
 *  Normalized through a real calendar so an anniversary that doesn't exist —
 *  Feb 29 → a non-leap year — CLAMPS to the last valid day of that month
 *  (Feb 28) instead of producing "2025-02-29" (an invalid date that the PDF
 *  would print verbatim while the UI's Date parser silently rolled to Mar 1). */
export function computeWarrantyEndDate(startYmd: string | null, years: number): string | null {
  if (!startYmd) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startYmd);
  if (!m) return null;
  const year = parseInt(m[1], 10) + Math.max(0, Math.floor(years));
  const month = parseInt(m[2], 10); // 1-12
  const day = parseInt(m[3], 10);
  // Last valid day of the target month (Date.UTC(year, month, 0) → last day of
  // the 1-indexed `month`). Clamp so Feb 29 → Feb 28 in a non-leap year.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const d = Math.min(Math.max(1, day), lastDay);
  return `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Progress: received (or N/A) ÷ included items. Null when no included items. */
export function closeoutProgressPct(
  items: ReadonlyArray<{ included: boolean; item_status: CloseoutItemStatus }>
): number | null {
  const included = items.filter((i) => i.included);
  if (included.length === 0) return null;
  const done = included.filter((i) => i.item_status === "received" || i.item_status === "na").length;
  return Math.round((done / included.length) * 100);
}
