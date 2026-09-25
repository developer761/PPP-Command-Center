/**
 * The Accounting page's in-page views — the tab bar itself.
 *
 * Karan, 2026-08-19: *"I don't want it to bring me to the reports page but just
 * keep me on the same page."* The old bottom "Go deeper" row navigated away, so
 * the money desk was really a launcher — you left it to do anything. These
 * render inline instead: the URL stays /commercial/accounting, the headline
 * figures stay on screen above the switcher, and nothing is lost on a switch.
 *
 * Invoices is the one thing still a real link: it is a workspace where records
 * get created and edited, not a read-only view, and embedding it would mean two
 * places that can create an invoice.
 *
 * ── WHY THIS LIVES IN lib/ AND NOT IN THE PAGE ─────────────────────────────
 *
 * The How-it-works handbook draws this tab strip so somebody can follow along
 * ("Accounting › Receivables — third tab"). It did that from a second, hand-typed
 * copy of the labels, and the copy went stale: Payroll was added on 2026-09-24
 * and Balance owed before it, and Mary's chapter — the one titled "The money",
 * claiming to be her whole day — showed neither. Worse, its `at:` indices
 * pointed at the tab strip's OLD positions, so the guide highlighted the wrong
 * tab on every surface after Receivables.
 *
 * A handbook that is confidently wrong about which tab to press is worse than
 * no handbook. One list, imported by both, is the only version of this that
 * cannot drift; `__tests__/commercial/guide-matches-the-accounting-tabs.test.ts`
 * holds the seam shut.
 *
 * No server imports here on purpose — the guide's PDF renderer pulls it in too.
 */
export const ACCOUNTING_VIEWS = [
  { key: "overview", label: "Overview", primary: true },
  // Karan 2026-09-24: "put payroll tab before receivables". It is the most
  // time-critical thing on this page — it runs to a deadline every week —
  // and the rest of the tabs are things you look up rather than things that
  // are due.
  { key: "payroll", label: "Payroll", primary: true },
  // Alex asked for Receivables by name; it carries the export + send actions.
  { key: "receivables", label: "Receivables", primary: true },
  // Alex's ledger. Sits next to Receivables on purpose: one answers "what is
  // owed", the other "what actually moved", and he reads them together.
  { key: "transactions", label: "Transactions", primary: false },
  { key: "aging", label: "AR aging", primary: false },
  { key: "cash", label: "Cash flow", primary: false },
  { key: "costs", label: "Job costs", primary: false },
  // The last two of Alex's reports the platform didn't carry.
  { key: "tax", label: "Sales tax", primary: false },
  { key: "reimbursements", label: "Reimbursements", primary: false },
  // Karan 2026-09-16: "all of Mary's stuff should be in accounting." These four
  // are Tomco's own Salesforce reports, rebuilt in the shape she reads them —
  // records grouped and subtotalled, not a chart of them. They were briefly
  // separate pages under Reports, which meant her work was in two places.
  // Mary's own AR sheet, generated from the AIA certificates she raises.
  { key: "ar", label: "AR sheet", primary: true },
  // Katie: "Balance Owed Report — only the projects which are completed but
  // there is still a balance due from the customer." It is one of the reports
  // she and Alex actually run, so it sits on the bar beside the AR sheet
  // rather than behind More.
  { key: "owed", label: "Balance owed", primary: true },
  // Won work with no invoice raised against it. Reached from the line on the
  // Overview, which used to send you to the dashboard and leave you to find
  // the jobs yourself.
  { key: "unbilled", label: "Won, not invoiced", primary: false },
  { key: "purchases", label: "Purchases", primary: true },
  { key: "labor-out", label: "Labor payments", primary: true },
  { key: "deposits", label: "Deposits", primary: true },
] as const;

export type AccountingView = (typeof ACCOUNTING_VIEWS)[number]["key"];

/**
 * The labels on the visible tab bar, in order — what the handbook draws and
 * what somebody counts along when told "the third tab". Everything else sits
 * behind More.
 */
export const ACCOUNTING_PRIMARY_LABELS: readonly string[] =
  ACCOUNTING_VIEWS.filter((v) => v.primary).map((v) => v.label);

/** Where a label sits on that bar, for the guide's highlight. -1 if absent. */
export function accountingTabIndex(label: string): number {
  return ACCOUNTING_PRIMARY_LABELS.indexOf(label);
}
