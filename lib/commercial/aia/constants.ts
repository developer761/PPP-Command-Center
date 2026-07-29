/**
 * AIA billing constants + the pure G702 summary math (Phase H). Client-safe —
 * no server imports — so the application UI can render the certificate lines
 * and the math can be unit-tested without a DB.
 */

export const AIA_APPLICATION_STATUSES = ["draft", "submitted", "paid"] as const;
export type AiaApplicationStatus = (typeof AIA_APPLICATION_STATUSES)[number];

export const AIA_STATUS_META: Record<
  AiaApplicationStatus,
  { label: string; tone: "charcoal" | "ppp-blue" | "emerald" }
> = {
  // Draft is neutral (not amber) — matches invoice/proposal draft across the
  // platform; amber is reserved for pending/warning states.
  draft: { label: "Draft", tone: "charcoal" },
  submitted: { label: "Submitted", tone: "ppp-blue" },
  paid: { label: "Paid", tone: "emerald" },
};

/** AIA's common default retainage. */
export const DEFAULT_RETAINAGE_PCT = 5;

/** One G703 continuation-sheet line's inputs (all cents). */
export type AiaLineInput = {
  scheduled_value_cents: number;
  from_previous_cents: number;
  this_period_cents: number;
  materials_stored_cents: number;
};

/** The computed G702 certificate summary (all cents). */
export type AiaG702 = {
  /** 1 — Original Contract Sum. */
  originalContractCents: number;
  /** 2 — Net change by approved Change Orders (Phase G). */
  netChangeOrdersCents: number;
  /** 3 — Contract Sum to Date = (1) + (2). */
  contractSumToDateCents: number;
  /** 4 — Total Completed & Stored to Date = Σ (D + E + F). */
  totalCompletedStoredCents: number;
  /** 5 — Retainage = retainagePct% of (4). */
  retainageCents: number;
  /** 6 — Total Earned Less Retainage = (4) − (5). */
  totalEarnedLessRetainageCents: number;
  /** 7 — Less Previous Certificates for Payment (prior period's line 6). */
  previousCertificatesCents: number;
  /** 8 — Current Payment Due = (6) − (7). */
  currentPaymentDueCents: number;
  /** 9 — Balance to Finish incl. Retainage = (3) − (6). */
  balanceToFinishCents: number;
  /** % of contract completed = (4) / (3). Null when contract sum is 0. */
  percentCompleteBps: number | null;
};

/** Cumulative completed + stored for one G703 line (columns D + E + F). */
export function lineCompletedStoredCents(l: AiaLineInput): number {
  return (
    Math.max(0, Math.round(l.from_previous_cents)) +
    Math.max(0, Math.round(l.this_period_cents)) +
    Math.max(0, Math.round(l.materials_stored_cents))
  );
}

/**
 * Pure G702 computation. Every input is cents; retainagePct is a percent (5 =
 * 5%); netChangeOrdersCents is the signed net of approved COs; prevCertsCents
 * is the immediately-prior application's Total Earned Less Retainage (line 6),
 * i.e. the AIA carry-forward.
 */
export function computeG702({
  originalContractCents,
  netChangeOrdersCents,
  retainagePct,
  lines,
  previousCertificatesCents,
}: {
  originalContractCents: number;
  netChangeOrdersCents: number;
  retainagePct: number;
  lines: AiaLineInput[];
  previousCertificatesCents: number;
}): AiaG702 {
  const contractSumToDate = originalContractCents + netChangeOrdersCents;
  const totalCompletedStored = lines.reduce((sum, l) => sum + lineCompletedStoredCents(l), 0);
  const pct = Math.min(100, Math.max(0, retainagePct));
  // Retainage (G702 line 5) is the SUM of PER-LINE rounded retainage — the same
  // way the G703 continuation sheet's retainage column totals — so the two
  // sheets always tie to the penny. (Rounding the total instead of per-line
  // drifts by ~N/2 cents and a GC's AP system can reject the mismatch.)
  const retainage = lines.reduce(
    (sum, l) => sum + Math.round((lineCompletedStoredCents(l) * pct) / 100),
    0
  );
  const totalEarnedLessRetainage = totalCompletedStored - retainage;
  const currentPaymentDue = totalEarnedLessRetainage - previousCertificatesCents;
  const balanceToFinish = contractSumToDate - totalEarnedLessRetainage;
  const percentCompleteBps =
    contractSumToDate > 0
      ? Math.round((totalCompletedStored / contractSumToDate) * 10000)
      : null;
  return {
    originalContractCents,
    netChangeOrdersCents,
    contractSumToDateCents: contractSumToDate,
    totalCompletedStoredCents: totalCompletedStored,
    retainageCents: retainage,
    totalEarnedLessRetainageCents: totalEarnedLessRetainage,
    previousCertificatesCents,
    currentPaymentDueCents: currentPaymentDue,
    balanceToFinishCents: balanceToFinish,
    percentCompleteBps,
  };
}

export function formatApplicationNumber(n: number): string {
  return `Application No. ${n}`;
}

/**
 * The ONE contract-base ladder, shared by the Projects card, the Account 360
 * production KPIs, the AIA G702 (via resolveG702), and the Change Orders page —
 * so all four always agree on "contract to date" for a deal. Once an AIA app
 * exists, its explicit snapshotted contract wins, else its schedule-of-values
 * total (which by AIA convention IS the contract sum); before any billing, the
 * deal's bid midpoint. Approved change orders are added on TOP of this base by
 * the caller.
 */
export function pickContractBaseCents(opts: {
  hasBillingApp: boolean;
  originalContractCents: number;
  sovTotalCents: number;
  bidMidCents: number;
}): number {
  if (opts.hasBillingApp) {
    if (opts.originalContractCents > 0) return opts.originalContractCents;
    if (opts.sovTotalCents > 0) return opts.sovTotalCents;
  }
  return opts.bidMidCents;
}
