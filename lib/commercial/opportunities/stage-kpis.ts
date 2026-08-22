import { formatCentsCompact } from "@/lib/commercial/invoices/format";
import { POST_SALE_STATUSES } from "@/lib/commercial/opportunities/constants";

/**
 * The numbers that matter at THIS stage of a job — and only those.
 *
 * Karan 2026-08-12: "the kpis should only show the relevant stages with info
 * like if we sent a proposal (how long ago?)". A bid never shows retainage; a
 * finished job never shows a proposal due date.
 *
 * Two rules run through all of it:
 *
 *  - **Elapsed time is a first-class number.** "Sent" is much less use than
 *    "sent 9 days ago"; the second one is what makes somebody pick up the
 *    phone. Days are counted on Eastern calendar dates, never by subtracting
 *    UTC timestamps, which silently shifts the count across DST.
 *
 *  - **Hide, never fake.** A tile with nothing real behind it is omitted
 *    rather than rendered as "$0" or "0 days ago". A zero is a number somebody
 *    chose; an absent tile is honest about not knowing.
 *
 * Pure — dates arrive as ET calendar strings and `todayIso` is injected — so
 * every rule here is testable without a clock or a database.
 */

export type KpiTone = "default" | "good" | "warn" | "bad";

export type StageKpi = {
  key: string;
  label: string;
  value: string;
  sub?: string | null;
  tone?: KpiTone;
  /** Where this number lives. Karan 2026-08-13: "add more small KPIs or
   *  important details with quick links if needed" — a figure you can click
   *  through to is worth more than one you have to go and find. Relative to
   *  the deal, so callers pass the tab. */
  href?: string;
};

export type StageKpiInput = {
  status: string;
  subStatus: string | null;
  /** ET calendar date, YYYY-MM-DD. */
  todayIso: string;

  rfpReceivedAt?: string | null;
  proposalDueAt?: string | null;
  followUpAt?: string | null;
  decidedAt?: string | null;
  closedOutAt?: string | null;

  /** The latest proposal the customer has actually SEEN, and when it went. */
  latestSentProposalCents?: number | null;
  latestSentProposalAt?: string | null;
  /** Highest current quote, sent or not — what the deal is "worth" pre-sale. */
  currentQuoteCents?: number | null;

  contractCents?: number | null;
  hasContract?: boolean;
  billedPreTaxCents?: number | null;
  collectedCents?: number | null;
  openBalanceCents?: number | null;
  grossMarginCents?: number | null;
  grossMarginPct?: number | null;
  /** True while a job is only part-billed, so the margin is a running figure
   *  rather than the final one. Saying so is the difference between a number
   *  someone trusts and a number they quote. */
  marginProvisional?: boolean;
  /**
   * The label + caveat `dealMargin` chose for THIS margin.
   *
   * The strip used to hardcode its own names — "Projected margin" in the
   * billing block, "Margin so far" / "Margin" in the closed block — while the
   * Costs tab called the same number "Gross margin". One figure, four names,
   * depending which tab you were on.
   *
   * Worse, the caveat was dropped. `dealMargin` says things like "Margin
   * understated — 12 crew hours have no cost rate", which is the difference
   * between a number you can quote and one you can't; the strip showed the
   * percentage alone.
   */
  marginLabel?: string | null;
  marginCaveat?: string | null;
  approvedChangeOrderCents?: number | null;

  openSubmittals?: number | null;
  /** Change orders raised and undecided — scope the GC hasn't answered on. */
  pendingChangeOrders?: number | null;
  crewHours?: number | null;
  oldestUnpaidInvoiceDate?: string | null;
  /** Retainage withheld on the latest AIA application — earned, not yet
   *  collectible. Money that lives in no other tile: it is excluded from
   *  Outstanding (nobody is late paying it) and it is not Collected. */
  retainageHeldCents?: number | null;
  /** Substantial completion + warranty term, as an ET calendar date. */
  warrantyThroughAt?: string | null;
};

/** Whole days between two ET calendar dates. Positive = `to` is later. */
export function daysBetweenEt(fromIso: string, toIso: string): number {
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
  const b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/** "today" · "yesterday" · "9 days ago" — never "0 days ago". */
export function agoLabel(dateIso: string, todayIso: string): string {
  const d = daysBetweenEt(dateIso, todayIso);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  return `${d} days ago`;
}

/** "in 4 days" · "due today" · "4 days overdue". */
function dueLabel(dateIso: string, todayIso: string): { text: string; tone: KpiTone } {
  const d = daysBetweenEt(todayIso, dateIso);
  if (d < 0) return { text: `${Math.abs(d)} day${Math.abs(d) === 1 ? "" : "s"} overdue`, tone: "bad" };
  if (d === 0) return { text: "due today", tone: "warn" };
  if (d <= 3) return { text: `in ${d} day${d === 1 ? "" : "s"}`, tone: "warn" };
  return { text: `in ${d} days`, tone: "default" };
}

/** Warranty runs in months, not days, so `dueLabel`'s "in 340 days" is the
 *  wrong register. Only the last stretch is actionable — that is the window to
 *  chase callbacks before the obligation lapses — so that is the only one that
 *  gets a tone. */
function warrantyLabel(dateIso: string, todayIso: string): { text: string; tone: KpiTone } {
  const d = daysBetweenEt(todayIso, dateIso);
  if (d < 0) return { text: "expired", tone: "default" };
  if (d === 0) return { text: "expires today", tone: "warn" };
  if (d <= 60) return { text: `${d} day${d === 1 ? "" : "s"} left`, tone: "warn" };
  return { text: `${Math.round(d / 30)} months left`, tone: "default" };
}

const DELIVERY = new Set<string>(POST_SALE_STATUSES);

/** Which phase's tiles to show. Separate from the status ladder because a won
 *  job that hasn't started reads differently from one on site. */
export function phaseFor(status: string, sub: string | null): string {
  if (status === "pre_sale_closed") return sub === "won" ? "won_not_started" : "lost";
  if (status === "post_sale_closed") return "closed";
  if (status === "billing") return "billing";
  if (status === "in_progress") return "in_progress";
  if (status === "pre_construction") return "won_not_started";
  if (status === "proposal") return "proposal_out";
  return "bidding";
}

export function stageKpis(i: StageKpiInput): StageKpi[] {
  const out: StageKpi[] = [];
  const phase = phaseFor(i.status, i.subStatus);
  const money = (c: number | null | undefined) => formatCentsCompact(c ?? 0);
  // A contract that nobody has set is NOT zero. Showing $0 makes an unknown
  // look like a decision, and it is the shape that poisons every rollup above.
  const hasContract = !!i.hasContract && (i.contractCents ?? 0) > 0;

  if (phase === "bidding" || phase === "proposal_out") {
    if (i.rfpReceivedAt) {
      out.push({
        key: "rfp",
        label: "Plans received",
        value: agoLabel(i.rfpReceivedAt, i.todayIso),
        sub: i.rfpReceivedAt,
      });
    }
    if (i.proposalDueAt) {
      const d = dueLabel(i.proposalDueAt, i.todayIso);
      out.push({ key: "due", label: "Proposal due", value: d.text, sub: i.proposalDueAt, tone: d.tone, href: "?tab=proposals" });
    }
  }

  if (phase === "proposal_out") {
    // The latest SENT proposal, not the latest created — a drafted revision
    // must not reset the clock on what the customer is actually holding.
    if ((i.latestSentProposalCents ?? 0) > 0) {
      out.push({
        key: "quote",
        label: "Proposal out",
        value: money(i.latestSentProposalCents),
        sub: i.latestSentProposalAt ? `sent ${agoLabel(i.latestSentProposalAt, i.todayIso)}` : null,
        href: "?tab=proposals",
      });
    } else if ((i.currentQuoteCents ?? 0) > 0) {
      out.push({ key: "quote", label: "Current quote", value: money(i.currentQuoteCents), href: "?tab=proposals" });
    }
    if (i.followUpAt) {
      const d = dueLabel(i.followUpAt, i.todayIso);
      out.push({ key: "follow_up", label: "Follow-up", value: d.text, sub: i.followUpAt, tone: d.tone, href: "?tab=activity&sub=tasks" });
    }
  } else if (phase === "bidding" && (i.currentQuoteCents ?? 0) > 0) {
    out.push({ key: "quote", label: "Current quote", value: money(i.currentQuoteCents), href: "?tab=proposals" });
  }

  if (phase === "won_not_started") {
    out.push(
      hasContract
        // "not set" is the one tile people MUST act on, and it had nowhere to
        // go — Info is where the contract sum is entered.
        ? { key: "contract", label: "Contract", value: money(i.contractCents), tone: "good", href: "?tab=info" }
        : { key: "contract", label: "Contract", value: "not set", tone: "warn", href: "?tab=info" }
    );
    if (i.decidedAt) {
      out.push({ key: "won_ago", label: "Won", value: agoLabel(i.decidedAt, i.todayIso), sub: i.decidedAt });
    }
    // Pre-construction is a checklist, so the two things blocking mobilisation
    // belong on the board rather than one click down.
    if ((i.openSubmittals ?? 0) > 0) {
      out.push({
        key: "submittals",
        label: "Open submittals",
        value: String(i.openSubmittals),
        sub: "with the GC",
        tone: "warn",
        href: "?tab=project&sub=submittals",
      });
    }
    // Karan 2026-08-13: "the overview when we're on delivery should have KPIs
    // of how much we have to bill them, how much we have billed so far."
    // `won_not_started` covers Pre-Construction, which IS delivery — so the
    // billing picture has to start here, not only once the crew is on site.
    // At this stage "left to bill" is usually the whole contract, which is
    // exactly the answer to "how much do we have to bill them".
    if (hasContract) {
      const left = (i.contractCents ?? 0) - (i.billedPreTaxCents ?? 0);
      out.push({
        key: "left_to_bill",
        label: left < 0 ? "Over-billed" : "Left to bill",
        value: money(Math.abs(left)),
        tone: left < 0 ? "warn" : left === 0 ? "good" : "default",
        href: "?tab=project&sub=aia",
      });
      // Only once something HAS been billed — a deposit can go out before the
      // crew mobilises, and "Billed 0%" on a job nobody has started is noise.
      if ((i.billedPreTaxCents ?? 0) > 0) {
        out.push({
          key: "billed",
          label: "Billed",
          value: `${Math.round(((i.billedPreTaxCents ?? 0) / (i.contractCents || 1)) * 100)}%`,
          sub: `${money(i.billedPreTaxCents)} of ${money(i.contractCents)}`,
          href: "?tab=project&sub=invoices",
      });
      }
    }
    if (hasContract && i.grossMarginPct != null) {
      out.push({
        key: "margin",
        // The source's own name for it, so this tab and the Costs tab agree.
        label: i.marginLabel ?? "Projected margin",
        value: `${i.grossMarginPct}%`,
        // A caveat outranks restating the dollars: it says the number is
        // incomplete, and the dollars are one click away on Costs.
        sub: i.marginCaveat ?? money(i.grossMarginCents),
        tone: i.grossMarginPct < 0 ? "bad" : i.grossMarginPct < 15 ? "warn" : "good",
        href: "?tab=project&sub=transactions",
      });
    }
  }

  if (phase === "in_progress" || phase === "billing") {
    if (hasContract) {
      const pct = Math.round(((i.billedPreTaxCents ?? 0) / (i.contractCents || 1)) * 100);
      out.push({
        key: "billed",
        label: "Billed",
        value: `${pct}%`,
        sub: `${money(i.billedPreTaxCents)} of ${money(i.contractCents)}`,
        tone: pct > 100 ? "warn" : "default",
        href: "?tab=project&sub=invoices",
      });
    }
    // Karan 2026-08-13: "the overview when we're on delivery should have KPIs
    // of like how much we have to bill them, how much we have billed so far."
    // Billed answers half of it; this is the half people actually plan around,
    // and it is the one number nobody could get without doing the subtraction
    // in their head. Against contract TO DATE, so an approved CO reopens a job
    // that had been fully billed instead of leaving it reading "nothing left".
    if (hasContract) {
      const left = (i.contractCents ?? 0) - (i.billedPreTaxCents ?? 0);
      out.push({
        key: "left_to_bill",
        label: left < 0 ? "Over-billed" : "Left to bill",
        value: money(Math.abs(left)),
        // Over-billing is not netted away or hidden: it is a real state, it
        // happens on progress billing, and it needs correcting rather than
        // rounding to zero.
        tone: left < 0 ? "warn" : left === 0 ? "good" : "default",
        href: "?tab=project&sub=invoices",
      });
    }
    if ((i.approvedChangeOrderCents ?? 0) !== 0) {
      out.push({ key: "cos", label: "Approved COs", value: money(i.approvedChangeOrderCents), href: "?tab=project&sub=change-orders" });
    }
    if (i.grossMarginPct != null && hasContract) {
      out.push({
        key: "margin",
        label: i.marginLabel ?? (i.marginProvisional ? "Margin so far" : "Margin"),
        value: `${i.grossMarginPct}%`,
        sub: i.marginCaveat ?? money(i.grossMarginCents),
        tone: i.grossMarginPct < 0 ? "bad" : i.grossMarginPct < 15 ? "warn" : "good",
        href: "?tab=project&sub=transactions",
      });
    }
  }

  if (phase === "in_progress") {
    if ((i.openSubmittals ?? 0) > 0) {
      out.push({
        key: "submittals",
        label: "Open submittals",
        value: String(i.openSubmittals),
        tone: "warn",
        href: "?tab=project&sub=submittals",
      });
    }
    // A change order nobody has answered is scope in limbo — the crew may
    // already be doing the work.
    if ((i.pendingChangeOrders ?? 0) > 0) {
      out.push({
        key: "pending_cos",
        label: "COs awaiting a decision",
        value: String(i.pendingChangeOrders),
        tone: "warn",
        href: "?tab=project&sub=change-orders",
      });
    }
    if ((i.crewHours ?? 0) > 0) {
      out.push({ key: "hours", label: "Crew hours", value: `${i.crewHours}`, // Crew hours live in Field Ops, not on the deal — scheduling must not
        // fork into a per-job silo. The hours view takes no job filter, so this
        // lands on the tool rather than pretending to be pre-filtered.
        href: "/commercial/field-ops/hours" });
    }
  }

  if (phase === "billing" || phase === "closed") {
    if ((i.openBalanceCents ?? 0) > 0) {
      out.push({
        key: "ar",
        href: "?tab=project&sub=invoices",
        label: "Outstanding",
        value: money(i.openBalanceCents),
        sub: i.oldestUnpaidInvoiceDate
          ? `oldest ${agoLabel(i.oldestUnpaidInvoiceDate, i.todayIso)}`
          : null,
        tone: "warn",
      });
    } else if ((i.collectedCents ?? 0) > 0) {
      out.push({ key: "ar", label: "Collected", value: money(i.collectedCents), tone: "good", href: "?tab=project&sub=invoices" });
    }
    // Retainage is the money a GC holds back on every application. It is
    // earned, it is not late, and it appears in NEITHER tile above — so
    // without this the deal page shows a job as fully collected while 5% of
    // the contract is still sitting with the GC.
    if ((i.retainageHeldCents ?? 0) > 0) {
      out.push({
        key: "retainage",
        href: "?tab=project&sub=aia",
        label: "Retainage held",
        value: money(i.retainageHeldCents),
        sub:
          hasContract
            ? `${Math.round(((i.retainageHeldCents ?? 0) / (i.contractCents || 1)) * 100)}% of contract`
            : null,
        tone: "warn",
      });
    }
  }

  if (phase === "closed") {
    if (hasContract && i.grossMarginPct != null) {
      out.push({
        key: "final_margin",
        // "Final" is worth saying on a closed job — but only when it IS final.
        // dealMargin marks a margin provisional when something is missing (crew
        // hours with no cost rate, nothing billed yet), and a closed job with
        // unrated labour does not have a final margin no matter what the status
        // column says. Calling it one is how a wrong number gets quoted.
        label: i.marginProvisional ? (i.marginLabel ?? "Margin so far") : "Final margin",
        value: `${i.grossMarginPct}%`,
        sub: i.marginCaveat ?? money(i.grossMarginCents),
        tone: i.grossMarginPct < 0 ? "bad" : i.grossMarginPct < 15 ? "warn" : "good",
        href: "?tab=project&sub=transactions",
      });
    }
    if (i.closedOutAt) {
      out.push({ key: "closed", label: "Closed out", value: agoLabel(i.closedOutAt, i.todayIso), sub: i.closedOutAt });
    }
    // The obligation that outlives the job. Nothing else on the platform
    // surfaces it at a glance, and "are we still on the hook for this?" is the
    // first question asked when a call-back comes in.
    if (i.warrantyThroughAt) {
      const w = warrantyLabel(i.warrantyThroughAt, i.todayIso);
      out.push({ key: "warranty", label: "Warranty", value: w.text, sub: i.warrantyThroughAt, tone: w.tone });
    }
  }

  if (phase === "lost" && i.decidedAt) {
    out.push({ key: "lost", label: "Lost", value: agoLabel(i.decidedAt, i.todayIso), sub: i.decidedAt });
  }

  return out;
}

/** True when the job is past the sale — used to decide whether the compact
 *  stats row shows the project identity or the bid's. */
export function isDeliveryPhase(status: string): boolean {
  return DELIVERY.has(status);
}
