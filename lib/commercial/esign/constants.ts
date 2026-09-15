/**
 * Commercial proposal e-signature — shared vocabulary. Client-safe: no server
 * imports, so the signing page, the proposal card and the report all read the
 * same labels.
 *
 * The DB CHECK constraints in migration 20260915180000 mirror these lists, and
 * `npm run check:enums` inserts every value against them — add a value in both
 * places or the check goes red.
 */

export const SIGNATURE_REQUEST_STATUSES = [
  "awaiting_customer",
  "awaiting_countersign",
  "completed",
  "declined",
  "voided",
  "expired",
] as const;
export type SignatureRequestStatus = (typeof SIGNATURE_REQUEST_STATUSES)[number];

export const SIGNATURE_EVENT_TYPES = [
  "CREATE",
  "EMAIL",
  "VIEW",
  "CONSENT",
  "SUBMIT",
  "DECLINE",
  "COUNTERSIGN",
  "COMPLETE",
  "VOID",
  "EXPIRE",
] as const;
export type SignatureEventType = (typeof SIGNATURE_EVENT_TYPES)[number];

/** A signing link is good for 30 days. Long enough for a GC's approval chain,
 *  short enough that a forgotten link in an inbox isn't live forever. */
export const SIGNATURE_LINK_TTL_DAYS = 30;

/** Link tokens are 32 random bytes, base64url — always exactly 43 characters.
 *  Checked before any database read so a junk URL costs nothing. */
export const SIGNATURE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isSignatureTokenShaped(token: string | null | undefined): token is string {
  return typeof token === "string" && SIGNATURE_TOKEN_PATTERN.test(token);
}

export const SIGNATURE_STATUS_LABEL: Record<SignatureRequestStatus, string> = {
  awaiting_customer: "Awaiting customer",
  awaiting_countersign: "Awaiting countersignature",
  completed: "Fully signed",
  declined: "Declined",
  voided: "Voided",
  expired: "Expired",
};

/** Platform color rule: green = done, amber = in progress, grey = not started
 *  or dead. A decline is the one red — somebody said no. */
export const SIGNATURE_STATUS_TONE: Record<SignatureRequestStatus, "green" | "amber" | "grey" | "red"> = {
  awaiting_customer: "amber",
  awaiting_countersign: "amber",
  completed: "green",
  declined: "red",
  voided: "grey",
  expired: "grey",
};

/** Statuses in which the link still does something for the customer. */
export function isOpenForCustomer(status: SignatureRequestStatus): boolean {
  return status === "awaiting_customer";
}

/**
 * What the customer's link should do right now.
 *
 * Pure, so the rules that decide whether a legal signature can be taken are
 * unit-tested rather than scattered through a page and three routes. `now` is
 * injectable for the same reason.
 *
 * A proposal that has moved on (superseded by a revision, deleted, lost) kills
 * any link still waiting on the customer: signing it would accept a price and
 * scope that are no longer on the table. A proposal already marked WON is
 * still signable — "verbal yes, paperwork follows" is the normal order.
 */
export type LinkState =
  | { kind: "sign" }
  | { kind: "signed"; status: "awaiting_countersign" | "completed" }
  | { kind: "declined" }
  | { kind: "expired"; persist: boolean }
  | { kind: "voided"; persist: boolean; reason: string };

export function resolveLinkState(input: {
  status: SignatureRequestStatus;
  expiresAt: string;
  proposalStatus: string | null;
  proposalDeleted: boolean;
  now?: Date;
}): LinkState {
  const now = input.now ?? new Date();
  switch (input.status) {
    case "awaiting_countersign":
    case "completed":
      return { kind: "signed", status: input.status };
    case "declined":
      return { kind: "declined" };
    case "expired":
      return { kind: "expired", persist: false };
    case "voided":
      return { kind: "voided", persist: false, reason: "" };
    case "awaiting_customer":
      break;
  }
  if (input.proposalDeleted || !input.proposalStatus) {
    return { kind: "voided", persist: true, reason: "The proposal was deleted." };
  }
  if (input.proposalStatus === "superseded") {
    return { kind: "voided", persist: true, reason: "A revised proposal replaced this one." };
  }
  if (input.proposalStatus !== "sent" && input.proposalStatus !== "won") {
    return {
      kind: "voided",
      persist: true,
      reason: `The proposal is no longer out for signature (${input.proposalStatus}).`,
    };
  }
  if (new Date(input.expiresAt).getTime() <= now.getTime()) {
    return { kind: "expired", persist: true };
  }
  return { kind: "sign" };
}

/** "2026-09-15 01:17:36 PM America/New_York" — the certificate's timestamp
 *  format, matching the S-Docs trail PPP already files. */
export function formatAuditTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} ${get("dayPeriod")} America/New_York`;
}

/** "Sep 15, 2026, 1:17 PM ET" — for screens. */
export function formatSignedAt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })} ET`;
}

/** Signer input limits, enforced on the server and mirrored by the form. */
export const SIGNER_FIELD_MAX = 120;
export const DECLINE_REASON_MAX = 1000;
/** A signature PNG is a few KB; 400 KB is generous and still bounds a hostile
 *  upload well under the route's body limit. */
export const SIGNATURE_PNG_MAX_BYTES = 400 * 1024;
