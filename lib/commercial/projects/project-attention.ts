/**
 * "Needs attention" for a project — the hero of the Project command center.
 *
 * Karan 2026-08-14: the Project tab as a launcher "feels obsolete." A launcher
 * lists where things live; this lists what to DO, ranked, so the tab answers
 * the question everyone actually has on a live job — Alex ("is this on track?"),
 * Katie ("what's owed / to bill?"), Brendan ("what's waiting on the GC?"),
 * Stephanie ("are we ready to be on site?").
 *
 * Pure: every flag arrives already computed from the page's project reads, and
 * money formatting is injected, so the ranking rules are testable without a
 * database or a clock.
 */

export type AttentionSeverity = "high" | "med" | "low";

export type AttentionItem = {
  key: string;
  severity: AttentionSeverity;
  /** The action, short. */
  title: string;
  /** The number/why, optional. */
  detail?: string;
  /** Where to go to act on it. */
  href: string;
};

export type ProjectAttentionInput = {
  onSite: boolean;
  billing: boolean;
  hasContract: boolean;
  contractCents: number;
  billedPreTaxCents: number;
  openInvoiceCents: number;
  /** The single most-overdue issued invoice with a balance, if any. */
  overdueInvoice: { number: string; balanceCents: number; daysLate: number } | null;
  retainageCents: number;
  pendingCoCount: number;
  pendingCoCents: number;
  /** A won job whose submittals haven't gone to the GC yet. */
  submittalsNotSent: boolean;
  /** Job is fully billed but close-out hasn't been started. */
  closeoutNotStarted: boolean;
  crewHours: number;
  /** Days until the target start (negative = already past). Null when unset. */
  targetStartInDays: number | null;
  hrefs: {
    invoices: string;
    changeOrders: string;
    submittals: string;
    aia: string;
    closeout: string;
    schedule: string;
  };
};

/** The job's money at a glance — a mini P&L for the Project command center. */
export type ProjectMoney = {
  hasContract: boolean;
  contractCents: number;
  baseCents: number;
  approvedCoCents: number;
  billedCents: number;
  collectedCents: number;
  outstandingCents: number;
  retainageCents: number;
  costsCents: number;
  marginCents: number;
  marginPct: number | null;
};

/** The job's dates + crew, pre-formatted on the server (which owns ET-today). */
export type ProjectSchedule = {
  wonIso: string | null;
  targetStartIso: string | null;
  targetEndIso: string | null;
  /** Days until target start (negative = past). Null when unset. */
  startInDays: number | null;
  crewHours: number;
  onSite: boolean;
};

const RANK: Record<AttentionSeverity, number> = { high: 0, med: 1, low: 2 };

export function deriveProjectAttention(
  i: ProjectAttentionInput,
  money: (cents: number) => string
): AttentionItem[] {
  const out: AttentionItem[] = [];

  // 🔴 Money already late — the one number a GC's slow-pay turns into a problem.
  if (i.overdueInvoice) {
    out.push({
      key: "overdue",
      severity: "high",
      title: `Invoice ${i.overdueInvoice.number} overdue`,
      detail: `${money(i.overdueInvoice.balanceCents)} out · ${i.overdueInvoice.daysLate} day${i.overdueInvoice.daysLate === 1 ? "" : "s"} late`,
      href: i.hrefs.invoices,
    });
  }

  // 🟡 Scope the GC hasn't answered on — the crew may already be doing the work.
  if (i.pendingCoCount > 0) {
    out.push({
      key: "pending-co",
      severity: "med",
      title: `${i.pendingCoCount} change order${i.pendingCoCount === 1 ? "" : "s"} awaiting the GC`,
      detail: i.pendingCoCents > 0 ? money(i.pendingCoCents) : undefined,
      href: i.hrefs.changeOrders,
    });
  }

  // 🟡 Pre-construction gate — submittals have to be back before anyone mobilises.
  if (i.submittalsNotSent) {
    out.push({
      key: "submittals",
      severity: "med",
      title: "Submittals not sent to the GC",
      href: i.hrefs.submittals,
    });
  }

  // 🟡 Start date is close and no one is on the calendar for it.
  if (
    i.targetStartInDays !== null &&
    i.targetStartInDays >= 0 &&
    i.targetStartInDays <= 7 &&
    i.crewHours === 0 &&
    !i.onSite
  ) {
    out.push({
      key: "crew",
      severity: "med",
      title: "Crew not scheduled",
      detail: `target start ${i.targetStartInDays === 0 ? "today" : `in ${i.targetStartInDays} day${i.targetStartInDays === 1 ? "" : "s"}`}`,
      href: i.hrefs.schedule,
    });
  }

  // ⚪ Work done but not yet invoiced — the money that hasn't gone out.
  if (i.hasContract && (i.onSite || i.billing) && i.contractCents > i.billedPreTaxCents) {
    out.push({
      key: "left-to-bill",
      severity: "low",
      title: `${money(i.contractCents - i.billedPreTaxCents)} left to bill`,
      href: i.hrefs.aia,
    });
  }

  // ⚪ Earned, not late, sitting with the GC — invisible in AR without this.
  if (i.retainageCents > 0) {
    out.push({
      key: "retainage",
      severity: "low",
      title: `${money(i.retainageCents)} retainage held`,
      href: i.hrefs.aia,
    });
  }

  // ⚪ Billed but not collected (and not already flagged overdue above).
  if (!i.overdueInvoice && i.openInvoiceCents > 0) {
    out.push({
      key: "outstanding",
      severity: "low",
      title: `${money(i.openInvoiceCents)} outstanding`,
      href: i.hrefs.invoices,
    });
  }

  // ⚪ Fully billed but the paperwork to close it out hasn't begun.
  if (i.closeoutNotStarted && i.hasContract && i.billedPreTaxCents >= i.contractCents) {
    out.push({
      key: "closeout",
      severity: "low",
      title: "Close-out not started",
      detail: "job is fully billed",
      href: i.hrefs.closeout,
    });
  }

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}
