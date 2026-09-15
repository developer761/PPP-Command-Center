import type { SignatureRequestStatus } from "./constants";

/**
 * Reports → Signatures: the numbers. Pure, so the counting rules are tested
 * rather than trusted.
 *
 * Counted per PROPOSAL, not per link. A proposal re-sent to three addresses is
 * one proposal out for signature; counting links would make every re-send look
 * like a new deal and every unanswered duplicate look like a customer ignoring
 * us.
 */

export type SignatureReportInput = {
  proposal_id: string;
  status: SignatureRequestStatus;
  created_at: string;
  customer_signed_at: string | null;
  countersigned_at: string | null;
};

export type SignatureReportSummary = {
  proposalsSent: number;
  proposalsSigned: number;
  fullySigned: number;
  awaitingCustomer: number;
  awaitingCountersign: number;
  declined: number;
  signRatePct: number | null;
  /** Median hours from link sent to the customer's signature. */
  medianHoursToSign: number | null;
  /** Median hours from the customer's signature to our countersignature. */
  medianHoursToCountersign: number | null;
};

const HOUR = 3_600_000;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function summarizeSignatures(rows: SignatureReportInput[]): SignatureReportSummary {
  const byProposal = new Map<string, SignatureReportInput[]>();
  for (const r of rows) {
    const list = byProposal.get(r.proposal_id) ?? [];
    list.push(r);
    byProposal.set(r.proposal_id, list);
  }

  let proposalsSigned = 0;
  let fullySigned = 0;
  let awaitingCustomer = 0;
  let awaitingCountersign = 0;
  let declined = 0;
  const toSign: number[] = [];
  const toCountersign: number[] = [];

  for (const list of byProposal.values()) {
    // The link that carries the signature decides the proposal's state; if
    // none does, the proposal is still out if ANY link is still open.
    const signed = list.find((r) => r.customer_signed_at && (r.status === "awaiting_countersign" || r.status === "completed"));
    if (signed) {
      proposalsSigned += 1;
      if (signed.status === "completed") fullySigned += 1;
      else awaitingCountersign += 1;
      toSign.push((Date.parse(signed.customer_signed_at!) - Date.parse(signed.created_at)) / HOUR);
      if (signed.countersigned_at) {
        toCountersign.push((Date.parse(signed.countersigned_at) - Date.parse(signed.customer_signed_at!)) / HOUR);
      }
      continue;
    }
    if (list.some((r) => r.status === "awaiting_customer")) awaitingCustomer += 1;
    else if (list.some((r) => r.status === "declined")) declined += 1;
  }

  const proposalsSent = byProposal.size;
  const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
  return {
    proposalsSent,
    proposalsSigned,
    fullySigned,
    awaitingCustomer,
    awaitingCountersign,
    declined,
    signRatePct: proposalsSent > 0 ? Math.round((proposalsSigned / proposalsSent) * 100) : null,
    medianHoursToSign: round1(median(toSign)),
    medianHoursToCountersign: round1(median(toCountersign)),
  };
}

/** "3.5h" under two days, "4d" beyond — how long a signature took. */
export function formatDuration(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours * 10) / 10}h`;
  return `${Math.round(hours / 24)}d`;
}
