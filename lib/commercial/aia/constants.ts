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
  /** Optional so existing callers compile unchanged. Only the SALES TAX row
   *  needs to be identifiable here — see isAiaTaxLine and computeG702. */
  item_no?: string | null;
};

/** The computed G702 certificate summary (all cents). */
export type AiaG702 = {
  /** 1 — Original Contract Sum. */
  originalContractCents: number;
  /** 2 — Net change by approved Change Orders (Phase G). */
  netChangeOrdersCents: number;
  /** Sales tax on this contract, when the job is taxable. Its own component of
   *  line 3 rather than part of line 1, so a certificate arriving mid-job takes
   *  the tax off WITHOUT restating the contract the GC signed. */
  salesTaxCents: number;
  /** 3 — Contract Sum to Date = (1) + (2) + sales tax. */
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
  /**
   * How far line 3 sits from the G703 grand total (line 3 − Σ scheduled value).
   *
   * AIA's footing rule is that the continuation sheet's scheduled-value column
   * totals to the contract sum on the cover sheet. Nothing in the data model
   * enforces it: the G703 is written once at seed while lines 1 and 2 track the
   * deal, so an approved change order pushes them apart. Non-zero here means the
   * certificate does not add up — a GC's accounts-payable system can reject it —
   * so it is reported rather than quietly tolerated.
   */
  sovVarianceCents: number;
  /** 9 — Balance to Finish incl. Retainage = (3) − (6). */
  balanceToFinishCents: number;
  /** % of contract completed = (4) / (3). Null when contract sum is 0. */
  percentCompleteBps: number | null;
};

/**
 * Cumulative completed + stored for one G703 line (columns D + E + F).
 *
 * A CREDIT line — a deductive change order, whose scheduled value is negative —
 * earns DOWNWARD. The floor at zero was applied to every line, so a deduct row
 * was stuck at 0 no matter what: its scope came off the contract sum (line 3)
 * but never came off the completed total (line 4), so a job billed to 100% of
 * its remaining lines reported over 100% complete, a negative balance to
 * finish, and a final payment due that included the descoped work. The customer
 * gets billed for the thing they removed.
 *
 * So the clamp follows the SIGN of the line: a normal line can't go below zero,
 * a credit line can't go above it. Neither can drift past its own scheduled
 * value in the wrong direction, which is what the clamp was protecting against.
 */
export function lineCompletedStoredCents(l: AiaLineInput): number {
  // Clamped PER COLUMN, not on the sum — a stray negative in one column must
  // not reduce the others (that was the original rule and it still holds).
  const credit = Math.round(l.scheduled_value_cents) < 0;
  const fit = (v: number) => (credit ? Math.min(0, v) : Math.max(0, v));
  return (
    fit(Math.round(l.from_previous_cents)) +
    fit(Math.round(l.this_period_cents)) +
    fit(Math.round(l.materials_stored_cents))
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
  // Sales tax is read off its own G703 row, so line 3 and the schedule always
  // agree — sovVarianceCents exists precisely to catch them drifting apart, and
  // adding tax to one side only is how that would happen.
  const salesTaxCents = lines
    .filter((l) => isAiaTaxLine(l))
    .reduce((sum, l) => sum + Math.round(l.scheduled_value_cents), 0);
  const contractSumToDate = originalContractCents + netChangeOrdersCents + salesTaxCents;
  const sovTotal = lines.reduce(
    // NOT clamped at zero: a deductive change order is a real, negative line
    // on a real schedule of values, and dropping it here would make the sheet
    // total more than the contract it is supposed to foot to.
    (sum, l) => sum + Math.round(l.scheduled_value_cents),
    0
  );
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
    salesTaxCents,
    contractSumToDateCents: contractSumToDate,
    totalCompletedStoredCents: totalCompletedStored,
    retainageCents: retainage,
    totalEarnedLessRetainageCents: totalEarnedLessRetainage,
    previousCertificatesCents,
    currentPaymentDueCents: currentPaymentDue,
    balanceToFinishCents: balanceToFinish,
    percentCompleteBps,
    sovVarianceCents: contractSumToDate - sovTotal,
  };
}

/**
 * Collapse a deal's AIA payment applications into the two figures the deal's
 * financial rollups need — so an AIA-billed job stops reading "$0 billed"
 * (Phase D, Karan 2026-08-14). AIA is a SEPARATE billing ledger from
 * `commercial_invoices`; the deal financials sum only invoices, so AIA revenue
 * was invisible to the P&L, margin, delivery Billing stage, Account 360, and the
 * dashboard.
 *
 * Definitions (standard AIA accounting):
 *   - **billed** = the LATEST issued (submitted/paid) application's cumulative
 *     "Total Completed & Stored to date" (G702 line 4). That is the GROSS value
 *     of work certified to the GC — pre-retainage, directly comparable to the
 *     contract sum (also gross), matching how a regular invoice's pre-tax
 *     subtotal is "billed". Retainage is a payment-timing withholding, not a
 *     reduction in what was billed, so it stays IN this number.
 *   - **collected** = the LATEST PAID application's cumulative "Total Earned Less
 *     Retainage" (G702 line 6). AIA payment is sequential — paying application N
 *     settles everything earned-less-retainage through N — so the latest paid
 *     app's line 6 IS the cash collected to date (net of retainage). Retainage
 *     held stays uncollected, so `billed − collected` correctly carries it (plus
 *     any submitted-but-unpaid amount) as outstanding.
 *
 * Both figures are the cumulative line off ONE application each, so this works
 * identically for the single-deal detail path AND the batch (listProjects) path
 * — no per-application summing that the two surfaces could drift on.
 *
 * Pure so the money logic is unit-tested away from the DB; the async wrapper in
 * db.ts just resolves the two G702s and calls this.
 */
export function aiaBilledCollectedFrom(input: {
  /** G702 of the latest ISSUED (submitted/paid) application → billed. */
  latestIssued: Pick<
    AiaG702,
    "totalCompletedStoredCents" | "totalEarnedLessRetainageCents"
  > | null;
  /** G702 of the latest PAID application → collected. Null when nothing paid. */
  latestPaid: Pick<AiaG702, "totalEarnedLessRetainageCents"> | null;
}): {
  billedCents: number;
  collectedCents: number;
  /** G702 line 6 on the latest issued app — the part of `billed` the GC is
   *  contractually obliged to pay NOW. */
  earnedLessRetainageCents: number;
  /** billed − earned-less-retainage. Owed eventually, at close-out. */
  retainageHeldCents: number;
  /** THE AR FIGURE: earned-less-retainage minus what's been collected. */
  dueNowCents: number;
} {
  const billedCents = Math.max(0, input.latestIssued?.totalCompletedStoredCents ?? 0);
  // Line 6 can't exceed line 4; a bad import shouldn't produce negative retainage.
  const earnedLessRetainageCents = Math.min(
    billedCents,
    Math.max(0, input.latestIssued?.totalEarnedLessRetainageCents ?? 0)
  );
  const retainageHeldCents = Math.max(0, billedCents - earnedLessRetainageCents);
  const collectedRaw = Math.max(0, input.latestPaid?.totalEarnedLessRetainageCents ?? 0);
  // Never report more collected than billed (a data glitch shouldn't invent
  // negative outstanding on the CEO's dashboard).
  const collectedCents = Math.min(collectedRaw, billedCents);
  return {
    billedCents,
    collectedCents,
    earnedLessRetainageCents,
    retainageHeldCents,
    // NET OF RETAINAGE (decided 2026-08-17, docs/AIA_FINANCIALS_INTEGRATION.md).
    // Retainage is not payable until close-out, so counting it as receivable
    // would (a) overstate what any GC would acknowledge owing and (b) poison
    // the aging report — retainage sits for months BY DESIGN, so every AIA job
    // would read 90+ days past due and the report would stop meaning anything.
    // Construction accounting splits "AR — Trade" from "Retainage Receivable"
    // for exactly this reason. Retainage is carried separately, never dropped.
    dueNowCents: Math.max(0, earnedLessRetainageCents - collectedCents),
  };
}

/**
 * Is this G703 line a CHANGE ORDER line (G702 line 2), rather than base contract
 * work (line 1)?
 *
 * Tagged either by `change_order_id` (migration 128) or, for rows seeded before
 * that FK column existed (no backfill), by the `CO-###` item_no the seed used.
 * ONE definition so "base schedule-of-values total" means the same thing on the
 * seed snap, the live certificate, the App-2 carry-forward, and the portfolio
 * rollup — feeding a CO-inclusive SOV to the contract-base ladder is exactly
 * what double-counted every change order on line 3 (audit M2).
 */
export function isAiaChangeOrderLine(line: {
  change_order_id?: string | null;
  item_no?: string | null;
}): boolean {
  return !!line.change_order_id || /^CO-0*\d+$/i.test(line.item_no ?? "");
}

/**
 * The sales-tax row on the schedule of values.
 *
 * Stephanie 2026-09-01: "The sales tax needs to appear within the totals of the
 * scheduled values. With that, if we change the sales tax status because they
 * provided a cert later into the job if not after, we need the status to change
 * the values within the AIA."
 *
 * Its OWN row, deliberately, rather than folded into the contract. Her second
 * sentence is the reason: a cert can arrive mid-job, and the tax then has to
 * come off. If tax lived inside line 1, removing it would restate the Original
 * Contract Sum — telling the GC the contract changed when it did not. That is
 * the same confusion she described with alternates surfacing as change orders,
 * and it is the thing to avoid.
 *
 * So tax behaves like a change order in the arithmetic: outside the original
 * contract base, inside the contract sum to date. Line 1 stays the number they
 * signed, and the tax can go to zero without touching it.
 */
export const AIA_TAX_ITEM_NO = "TAX";

export function isAiaTaxLine(line: { item_no?: string | null }): boolean {
  return (line.item_no ?? "").trim().toUpperCase() === AIA_TAX_ITEM_NO;
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
  /** Total of the ACCEPTED (won) proposal — the signed contract number. */
  acceptedProposalCents?: number;
  /**
   * The contract sum a PERSON typed on this application.
   *
   * Ranked above everything, including a won proposal, because someone typing
   * here is correcting the number the ladder would otherwise pick — a
   * negotiated figure, a legacy job, a correction from the GC. The field saved
   * and was then discarded, which is worse than not offering it.
   */
  manualContractCents?: number;
  /**
   * The signed contract REMEMBERED ON THE DEAL (`accepted_contract_cents`).
   *
   * Needed because winning is recorded on the proposal, and creating a revision
   * supersedes it — so the moment an estimator re-quotes a won job, no proposal
   * reads `won` and the fact that $450k was signed disappears from the
   * proposals table entirely. The deal remembers it instead.
   */
  acceptedSnapshotCents?: number;
  /** Total of the LATEST proposal the customer has actually SEEN or decided on
   *  (highest revision among sent/won/lost/expired/superseded), used when no
   *  proposal is won yet — so the contract tracks the most recent real quote,
   *  never the first one. */
  latestProposalCents?: number;
  /**
   * Total of the latest PRE-SEND proposal (draft / pending approval / approved).
   *
   * The bottom rung, below even the bid midpoint. A number nobody outside the
   * office has seen must never outrank one they have — but it beats showing a
   * deal no contract at all, which is what happened once the bid low/high fields
   * were dropped from the create forms and `bidMidCents` became 0 for most deals.
   */
  pendingProposalCents?: number;
  bidMidCents: number;
}): number {
  // Karan 2026-08 (smoke-test fix): a WON proposal IS the signed contract and
  // must drive the contract EVERYWHERE — never the first proposal, never a stale
  // AIA original_contract seeded from an old bid. So the proposal sits at the
  // TOP of the ladder: won first, then the latest proposal if none is won yet.
  if (opts.manualContractCents && opts.manualContractCents > 0) return opts.manualContractCents;
  if (opts.acceptedProposalCents && opts.acceptedProposalCents > 0) return opts.acceptedProposalCents;
  // The remembered signed contract, for a won deal whose winning proposal was
  // superseded by a re-quote. Below the live `won` total on purpose: if a
  // proposal says `won` right now, that is the better answer, and re-winning a
  // deal re-writes the snapshot anyway.
  if (opts.acceptedSnapshotCents && opts.acceptedSnapshotCents > 0) return opts.acceptedSnapshotCents;
  if (opts.latestProposalCents && opts.latestProposalCents > 0) return opts.latestProposalCents;
  // No proposal the customer has seen: fall back to the AIA doc's explicit
  // contract / SOV (its system-of-record once billing starts), else the bid
  // midpoint, else an in-progress proposal as a last resort.
  // Once an AIA app exists it IS the system of record — answer from the document
  // even when that answer is zero. Falling past it to a bid range or a draft
  // would put a number on a certificate that the certificate doesn't contain.
  if (opts.hasBillingApp) {
    return opts.originalContractCents > 0 ? opts.originalContractCents : opts.sovTotalCents;
  }
  if (opts.bidMidCents > 0) return opts.bidMidCents;
  return opts.pendingProposalCents ?? 0;
}

/** The proposal fields the contract ladder needs. */
export type ContractProposalRow = {
  total_cents: number | string;
  status: string;
  revision_number: number;
};

/**
 * Which proposal totals may stand in as the contract — the ONE rule, shared by
 * the batch path (`listProjects`) and the single-opp path
 * (`contractLadderInputs`).
 *
 * It lived in both places, copied. That is the same defect twice over: a
 * divergence between them shows up as one job reporting two different contract
 * values on two screens, which is precisely what the ladder exists to prevent.
 *
 * The split is SEEN vs UNSEEN. `latestProposalCents` covers proposals the
 * customer has actually received or decided on (sent / won / lost / expired /
 * superseded). The pre-send trio (draft, pending approval, approved) is returned
 * separately as `pendingProposalCents`, for the bottom rung only.
 *
 * That split is the whole fix: an estimator opening a revision and typing its
 * first line must not move a number printed on a document the customer signed.
 * `superseded` stays eligible — superseding is just how a revision bump retires
 * the previous one, and that total was really sent to a real GC.
 */
const PRE_SEND_PROPOSAL_STATUSES = new Set(["draft", "pending_approval", "approved"]);

export function contractProposalCents(rows: ContractProposalRow[]): {
  acceptedProposalCents: number;
  latestProposalCents: number;
  pendingProposalCents: number;
} {
  let acceptedProposalCents = 0;
  let latestProposalCents = 0;
  let latestRev = -1;
  let pendingProposalCents = 0;
  let pendingRev = -1;
  for (const r of rows) {
    const cents = Number(r.total_cents) || 0;
    // If somehow >1 won proposal, keep the largest (defensive; should be one).
    if (r.status === "won") acceptedProposalCents = Math.max(acceptedProposalCents, cents);

    if (PRE_SEND_PROPOSAL_STATUSES.has(r.status)) {
      if (r.revision_number > pendingRev) {
        pendingRev = r.revision_number;
        pendingProposalCents = cents;
      }
      continue;
    }
    if (r.revision_number > latestRev) {
      latestRev = r.revision_number;
      latestProposalCents = cents;
    }
  }
  return { acceptedProposalCents, latestProposalCents, pendingProposalCents };
}

// ── When an AIA application falls due ────────────────────────────────────────

/**
 * The issue instant of an application, from whichever field recorded it.
 *
 * `frozen_at` is stamped when the certificate is issued and is the truth.
 * Older applications only carry `period_to`, a bare DATE, which is anchored at
 * 16:00Z — noon ET — so the day it lands on can't be flipped by a timezone.
 * Null when neither is recorded: unknown, never "today".
 */
export function aiaIssuedAtFrom(
  frozenAt: string | null | undefined,
  periodTo: string | null | undefined
): string | null {
  if (frozenAt) return frozenAt;
  return periodTo ? `${periodTo}T16:00:00Z` : null;
}

/**
 * When the money on that application is payable — issue instant plus the
 * standard terms.
 *
 * ONE definition. This ladder was written out three times — the AR-aging
 * report, the receivables chase list, and the dashboard's project rows — which
 * is three chances for a job to be late on one screen and current on another.
 * `dueDays` is passed in rather than imported so this module stays client-safe.
 */
export function aiaDueAtFrom(
  frozenAt: string | null | undefined,
  periodTo: string | null | undefined,
  dueDays: number
): string | null {
  const issued = aiaIssuedAtFrom(frozenAt, periodTo);
  if (!issued) return null;
  const ms = new Date(issued).getTime();
  if (Number.isNaN(ms)) return null;
  return new Date(ms + dueDays * 86_400_000).toISOString();
}
