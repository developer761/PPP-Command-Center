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
  /** Retainage held — money owed at CLOSE-OUT, not now. Deliberately NOT in
   *  `outstandingCents`, which is the currently-payable receivable (2026-08-17
   *  decision; see aiaBilledCollectedFrom). Render it as a sub-line under the
   *  owed-now figure, never as a peer tile that reads as a second debt. */
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
      title: "Closeout not started",
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
// Six stages, Won → Close-out. Each stage's marker reflects its OWN state —
// independent of the others — so doing billing or submittals "out of order"
// updates only THAT stage instead of forcing the earlier ones to read complete
// (Karan 2026-08-15). Three states: DONE (green ✓), PARTIAL (amber ✓ — activity
// but not finished; billing especially, since change orders keep it open), and
// TODO (grey, not started). A separate `current` flag marks the stage the deal
// officially sits at now, for a highlight ring.

export type SpineState = "done" | "partial" | "todo";
export type SpineStage = { key: string; label: string; state: SpineState; current: boolean; meta: string | null };

/** A delivery tool's coarse state + short label, as the strip already carries. */
export type SpineToolState = { status: "done" | "active" | "todo"; label: string } | null | undefined;

/** A tool that's in flight reads as PARTIAL (amber), not done. */
function toolSpineState(t: SpineToolState): SpineState {
  return t?.status === "done" ? "done" : t?.status === "active" ? "partial" : "todo";
}

export function deriveDeliverySpine(input: {
  status: string;
  wonLabel: string | null;
  onSite: boolean;
  submittals: SpineToolState;
  /** Billing = the AIA/invoices workstream. */
  billing: SpineToolState;
  closeout: SpineToolState;
  /** Preferred billing signal — finer than the tool's own state. */
  money?: { hasContract: boolean; contractCents: number; billedCents: number; collectedCents: number } | null;
}, fmt?: (cents: number) => string): SpineStage[] {
  // Sequential rank of the pipeline status. 0 = won but not yet started.
  const rank: Record<string, number> = { pre_construction: 1, in_progress: 2, billing: 3, post_sale_closed: 4 };
  const r = rank[input.status] ?? 0;

  // Pre-con + Production are pipeline phases: done once past them, partial (in
  // progress) while at them, todo before. Submittals + Close-out come from their
  // own tools. All independent — none forces another.
  const precon: SpineState = r >= 2 ? "done" : r === 1 ? "partial" : "todo";
  const production: SpineState = r >= 3 ? "done" : r === 2 || input.onSite ? "partial" : "todo";

  // Billing from the money when we have a contract: fully billed AND collected =
  // done; anything billed at all = partial (there may be more to bill, retainage
  // held, change orders open — the "yellow" state); nothing billed = todo. Falls
  // back to the tool's own state when there's no contract yet.
  let billing: SpineState;
  const mo = input.money;
  if (mo && mo.hasContract && mo.contractCents > 0) {
    if (mo.billedCents <= 0) billing = "todo";
    else if (mo.billedCents >= mo.contractCents && mo.collectedCents >= mo.billedCents) billing = "done";
    else billing = "partial";
  } else {
    billing = toolSpineState(input.billing);
  }

  // r === 0 is "won, nothing started". Pointing the ring at Pre-con there says
  // pre-construction is UNDERWAY on a job nobody has touched — the chevron bar
  // directly above already fixed exactly this (it passes currentKey null) and
  // the two then contradicted each other on one screen. Null = the whole ladder
  // is ahead of you, which is what won-not-started means.
  const currentKey =
    r >= 4 ? "closeout" : r === 3 ? "billing" : r === 2 ? "production" : r === 1 ? "precon" : null;

  // STAGE-level billing meta, not an invoice's. The invoices tool's own label is
  // things like "$50 paid in full" — true of that ONE invoice, but under the
  // Billing STAGE it reads as if the whole job is paid when only $50 of a large
  // contract is billed (Karan 2026-08-15). When we have the money + a formatter,
  // describe the stage: how much of the contract is billed.
  let billingMeta = input.billing?.label ?? null;
  if (mo && mo.hasContract && mo.contractCents > 0 && fmt) {
    billingMeta =
      billing === "done" ? "billed & collected" : billing === "partial" ? `${fmt(mo.billedCents)} of ${fmt(mo.contractCents)} billed` : "nothing billed yet";
  }

  const stages: SpineStage[] = [
    { key: "won", label: "Won", state: "done", current: false, meta: input.wonLabel },
    { key: "precon", label: "Pre-con", state: precon, current: false, meta: null },
    { key: "submittals", label: "Submittals", state: toolSpineState(input.submittals), current: false, meta: input.submittals?.label ?? null },
    { key: "production", label: "Production", state: production, current: false, meta: input.onSite ? "on site" : null },
    { key: "billing", label: "Billing", state: billing, current: false, meta: billingMeta },
    { key: "closeout", label: "Closeout", state: toolSpineState(input.closeout), current: false, meta: input.closeout?.label ?? null },
  ];
  for (const s of stages) s.current = s.key === currentKey;
  return stages;
}
