import type { ReportSpec } from "@/lib/commercial/reports/grouped/spec";
import type { WinLossRecord } from "@/lib/commercial/win-loss/reports";

/**
 * Win / Loss as RECORDS — which deals, not just how many.
 *
 * Karan 2026-09-16: this was the last report with no rows on it. A gauge
 * reading 38%, a donut splitting the dollars, and two bar lists saying we lose
 * to Acme on price — all true, none of it workable, because nothing named a
 * deal. And with no table there was no Export, so it was the one report nobody
 * could send on.
 *
 * The rows come from `getWinLossRecords`, which the headline figures are folded
 * from, so the table and the gauge above it are the same set by construction.
 *
 * GROUPINGS, in the order they get used:
 *   Outcome     — the default. Won, then Lost, then No bid, each subtotalled.
 *   GC          — Alex's question at review: who do we win with, who do we not.
 *   Why we lost — the losses gathered under their reason.
 */

/** Won before Lost before No bid, whatever the alphabet thinks. */
const OUTCOME_ORDER: Record<string, number> = { Won: 0, Lost: 1, "No bid": 2 };

/**
 * Under "Why we lost", an actual reason outranks the two buckets that are not
 * losses. Reasons fall through to `0<label>`, which sorts alphabetically ahead
 * of both — so a new reason needs no entry here.
 */
const REASON_GROUP_ORDER: Record<string, string> = {
  "Lost — no reason recorded": "1",
  "Won — no loss reason": "2",
  "No bid — we passed": "3",
};

const outcomeLabel = (r: WinLossRecord): string =>
  r.outcome === "won" ? "Won" : r.outcome === "lost" ? "Lost" : "No bid";

export const WIN_LOSS_SPEC: ReportSpec<WinLossRecord> = {
  title: "Win / Loss",
  sourceLabel: "Opportunities decided in this period",
  blurb:
    "Every deal decided in the window — what it was worth, who we were up against, and why the ones we lost went the other way.",
  totals: [
    { label: "Decided", kind: "number", value: (rows) => rows.filter((r) => r.outcome !== "no_bid").length },
    { label: "Won", value: (rows) => rows.filter((r) => r.outcome === "won").reduce((n, r) => n + r.valueCents, 0) },
    { label: "Lost", value: (rows) => rows.filter((r) => r.outcome === "lost").reduce((n, r) => n + r.valueCents, 0) },
    { label: "No bid", kind: "number", value: (rows) => rows.filter((r) => r.outcome === "no_bid").length },
  ],
  groupings: [
    [{ key: "outcome", label: "Outcome", of: outcomeLabel, sortBy: (l) => OUTCOME_ORDER[l] ?? 9 }],
    [{ key: "account", label: "GC", of: (r) => r.accountName }],
    /**
     * Losses gathered by reason.
     *
     * A win has no loss reason, and it is NOT dropped from this view — the
     * subtotals have to keep adding up to the same money however the report is
     * grouped, or switching the grouping silently changes the totals above it.
     *
     * But it used to group under the empty string, which the report renders as
     * an em-dash. On a quarter with twelve wins and no losses, pressing "Why
     * we lost" gave Brendan one group headed "— (12)" containing every deal he
     * had WON. The bucket was honest about having no reason and said nothing
     * about what was in it.
     *
     * Every group is named now. Reasons sort first, because they are what this
     * view is for; the two buckets that are not losses sink to the bottom.
     */
    [
      {
        key: "reason",
        label: "Why we lost",
        of: (r) =>
          r.outcome === "won"
            ? "Won — no loss reason"
            : r.outcome === "no_bid"
              ? "No bid — we passed"
              : (r.lossReason ?? "").trim() || "Lost — no reason recorded",
        sortBy: (label) => REASON_GROUP_ORDER[label] ?? `0${label}`,
      },
    ],
  ],
  columns: [
    { key: "opp", label: "Opportunity", text: (r) => r.name, href: (r) => `/commercial/opportunities/${r.oppId}` },
    { key: "gc", label: "GC", text: (r) => r.accountName, secondary: true },
    { key: "outcome", label: "Outcome", text: outcomeLabel },
    { key: "value", label: "Value", kind: "money", amount: (r) => r.valueCents },
    { key: "decided", label: "Decided", kind: "date", text: (r) => r.decidedYmd },
    { key: "reason", label: "Reason", text: (r) => r.lossReason, secondary: true },
    { key: "competitor", label: "Lost to", text: (r) => r.competitor, secondary: true },
  ],
};
