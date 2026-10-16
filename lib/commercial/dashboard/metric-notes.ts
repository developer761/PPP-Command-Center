/**
 * WHAT EACH DASHBOARD NUMBER MEANS — the text behind every ⓘ on /commercial.
 *
 * Alex asked (via Katie, 2026-10-15) for the date range and the criteria behind
 * every figure on the home screen. The answer lives HERE, in one file, beside
 * the code that computes the figures, so a change to a rule and a change to its
 * explanation land in the same diff. If you change what a tile counts, change
 * its note in the same commit — a footnote that describes last month's rule is
 * worse than none, because it is believed.
 *
 * Two kinds of figure, and every note says which it is:
 *   · RANGE — follows the period picker (billing, costs, profit, wins).
 *   · AS OF TODAY — a balance or a live list; the picker does not move it,
 *     because "what is owed in March" is not a question with a useful answer.
 *
 * Client-safe: plain strings, no server imports.
 */

export type MetricKey =
  | "netProfit" | "margin" | "grossRevenue" | "jobCosts"
  | "revenueChart" | "jobsInFlight" | "costBreakdown" | "revenueByProject"
  | "pipeline" | "open" | "wins" | "awaitingApproval" | "activeGcs" | "owedToUs"
  | "worklist"
  | "contract" | "billed" | "leftToBill" | "openActiveJobs"
  | "topOpen" | "recentActivity";

export type MetricNote = { scope: "range" | "today"; text: string };

/** @param rangeLabel the picker's resolved label, e.g. "FY26 to date". */
export function dashboardMetricNotes(rangeLabel: string): Record<MetricKey, MetricNote> {
  const R = `Period: ${rangeLabel}.`;
  const T = "As of today — the period picker does not change this.";
  return {
    // ── Are we making money? ──
    grossRevenue: {
      scope: "range",
      text: `${R} Everything billed in the period, before sales tax: invoices by the date they were sent (drafts and voids excluded), plus AIA applications by the billing period each covers, counting the work each application added. Includes retention (it is earned, just held). Covers every job, open or closed; archived deals and account-level invoices are excluded.`,
    },
    jobCosts: {
      scope: "range",
      text: `${R} Purchases logged on jobs, by purchase date, plus in-house (W-2) crew labor by the day it was worked — approved hours × each worker's cost rate. Weeks already posted through Payroll are counted once, from the payroll figure.`,
    },
    netProfit: { scope: "range", text: `${R} Gross revenue minus job costs, same period and same jobs.` },
    margin: {
      scope: "range",
      text: `${R} Net profit ÷ gross revenue. Labels: below 0% "losing money", below 15% "thin", otherwise "healthy". Hours with no cost rate are not costed, so they make margin read high.`,
    },
    revenueChart: {
      scope: "range",
      text: `${R} Billed revenue by month, same rules as Gross revenue (invoices by sent date + AIA by billing period, before tax). Shows at least the last 6 months for context. "This month" and "vs last" compare the current calendar month to date with all of last month.`,
    },
    jobsInFlight: {
      scope: "today",
      text: `${T} Jobs won and being delivered (pre-construction, in progress, billing) — up to 6, problems first: billed over contract, no work order, work order not sent, awaiting payment, nothing billed yet.`,
    },
    costBreakdown: { scope: "range", text: `${R} Job costs in the period split by purchase category, with crew labor as its own slice.` },
    revenueByProject: {
      scope: "range",
      text: `${R} The 6 jobs with the most billed in the period, each with its net (billed − that job's costs in the period).`,
    },

    // ── At a glance ──
    pipeline: {
      scope: "today",
      text: `${T} Open bids (qualifying, estimating, proposal), each weighted by its stage's win probability: deal value × probability. Deal value = signed contract, else the midpoint of the bid range, else the current proposal total. "+N new" = bids created in the last 7 days.`,
    },
    open: { scope: "today", text: `${T} Number of open bids — the same deals as Pipeline.` },
    wins: {
      scope: "range",
      text: `${R} Deals won in the period, by the date they were decided. Win % = won ÷ (won + lost) in the period, not counting no-bids; shown only once something has been lost. "vs last" compares with the previous period at the same point.`,
    },
    awaitingApproval: { scope: "today", text: `${T} Bids whose current proposal is waiting for internal approval.` },
    activeGcs: { scope: "today", text: `${T} General-contractor accounts not marked "do not bid". Not a measure of recent activity.` },
    owedToUs: {
      scope: "today",
      text: `${T} Money billed and not yet paid: sent invoices plus issued AIA applications (net of retention), plus retention held, which is shown separately because it is only collectible at close-out. Work won but not yet billed is NOT included. Same total as the Receivables report.`,
    },

    // ── What needs doing ──
    worklist: {
      scope: "today",
      text: `${T} Things to act on, biggest money first: invoices past their due date, finished jobs with contract left to bill, overdue or unanswered bids, follow-ups due, and jobs with no contract value. The dollar total counts only the money rows.`,
    },

    // ── Under contract ──
    contract: {
      scope: "today",
      text: `${T} Total contract value on active jobs (pre-construction, in progress, billing, and won-not-started), including approved change orders. "% billed" = billed ÷ contract.`,
    },
    billed: {
      scope: "today",
      text: `${T} Billed to date on those active jobs, BEFORE tax (invoices + AIA). The "% collected" underneath is measured against the INVOICED total, which includes tax — a different, larger number, named on the line so the percentage is not read as a share of the figure above it.`,
    },
    leftToBill: { scope: "today", text: `${T} Contract minus billed, per active job (never below zero).` },
    openActiveJobs: {
      scope: "today",
      text: `${T} Unpaid on active jobs only: open invoice balances plus AIA billed-and-unpaid (net of retention). Narrower than "Owed to us", which covers every job and includes retention.`,
    },

    // ── Lists ──
    topOpen: { scope: "today", text: `${T} The 5 open bids with the highest weighted value.` },
    recentActivity: { scope: "today", text: `${T} The 5 deals most recently changed, any status.` },
  };
}
