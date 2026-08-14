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

// ── Delivery spine ─────────────────────────────────────────────────────────
//
// The Project tab used to end in a grid of clickable tool cards (Submittals /
// Work Order / AIA / Costs …) — but those tools are already the deal's tab bar,
// so it was a second copy of the navigation ("serves no purpose", Karan
// 2026-08-15). This replaces it with a progress SPINE that answers the one
// thing the tabs can't: where is this job in delivery, right now.
//
// Six stages, Won → Close-out. The pipeline STATUS drives the sequential stages
// (Pre-con / Production / Billing); Submittals and Close-out read their own
// tool state, because they're parallel workstreams, not strictly sequential —
// so the spine can honestly show "in pre-con AND submittals out" at once.

export type SpineState = "done" | "current" | "todo";
export type SpineStage = { key: string; label: string; state: SpineState; meta: string | null };

/** A delivery tool's coarse state + short label, as the strip already carries. */
export type SpineToolState = { status: "done" | "active" | "todo"; label: string } | null | undefined;

function toolSpineState(t: SpineToolState): SpineState {
  return t?.status === "done" ? "done" : t?.status === "active" ? "current" : "todo";
}

export function deriveDeliverySpine(input: {
  status: string;
  wonLabel: string | null;
  onSite: boolean;
  submittals: SpineToolState;
  /** Billing = the AIA/invoices workstream. */
  billing: SpineToolState;
  closeout: SpineToolState;
}): SpineStage[] {
  // Sequential rank of the pipeline status. 0 = won but not yet started.
  const rank: Record<string, number> = { pre_construction: 1, in_progress: 2, billing: 3, post_sale_closed: 4 };
  const r = rank[input.status] ?? 0;

  const precon: SpineState = r >= 2 ? "done" : "current"; // won/pre-con → current; past it → done
  const production: SpineState = r >= 3 ? "done" : r === 2 ? "current" : "todo";
  const billingSeq: SpineState =
    r >= 4 ? "done" : r === 3 ? "current" : toolSpineState(input.billing) === "current" ? "current" : "todo";
  // Submittals + Close-out read their own tool state (parallel workstreams), but
  // fall back to the pipeline so a job that's already in production shows
  // submittals DONE even with no tool data, and a closed job sits at Close-out.
  const sub = toolSpineState(input.submittals);
  const submittals: SpineState = sub === "done" ? "done" : r >= 2 ? "done" : sub;
  const close = toolSpineState(input.closeout);
  const closeout: SpineState = close === "done" ? "done" : close === "current" ? "current" : r >= 4 ? "current" : "todo";

  return [
    { key: "won", label: "Won", state: "done", meta: input.wonLabel },
    { key: "precon", label: "Pre-con", state: precon, meta: precon === "done" ? "done" : null },
    { key: "submittals", label: "Submittals", state: submittals, meta: input.submittals?.label ?? null },
    { key: "production", label: "Production", state: production, meta: input.onSite ? "on site" : null },
    { key: "billing", label: "Billing", state: billingSeq, meta: input.billing?.label ?? null },
    { key: "closeout", label: "Close-out", state: closeout, meta: input.closeout?.label ?? null },
  ];
}
