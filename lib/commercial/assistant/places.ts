/**
 * Where everything is, and what you do there.
 *
 * Karan's brief for the assistant: "if a person was on the platform and knows
 * it like the back of their hand and could answer any question about it, it
 * should be like that."
 *
 * Half of knowing a system is knowing where things live. A registry of routes
 * cannot supply that — it knows a page called "Balance Owed" exists, not that
 * "how do I see who still owes us" ends there. So this is written by hand, in
 * the words people actually use: `does` is what you came to do, and the model
 * matches against it.
 *
 * It lives in the prompt rather than behind a tool call. It is small, it is
 * needed on almost every question, and a round-trip to fetch it would make the
 * common case slower for nothing.
 *
 * KEEP IT HONEST: a link to a page that does not do the thing is worse than no
 * answer, because it costs somebody a click and their trust. If a surface
 * changes, change it here.
 */

export type Place = {
  /** What to call it — the label on screen. */
  name: string;
  href: string;
  /** Plain sentences describing what somebody comes here to do. */
  does: string[];
  /** Who it is for, when that is not everybody. */
  who?: "finance" | "admin" | "field";
};

export const PLACES: Place[] = [
  // ── Money — Mary's side ───────────────────────────────────────────────────
  {
    name: "Accounting → Receivables",
    href: "/commercial/accounting?view=receivables",
    who: "finance",
    does: [
      "record a payment that came in",
      "see every job with money still out, with a chase note per line",
      "write or update the note on what has been chased",
      "email the receivables sheet to Alex",
    ],
  },
  {
    name: "Accounting → AR sheet",
    href: "/commercial/accounting?view=ar",
    who: "finance",
    does: [
      "see what has been certified and is waiting to be paid, with retention on its own line",
      "the sheet Mary sends on — edit a line, add one, or remove one",
      "export the AR sheet",
    ],
  },
  {
    name: "Accounting → Purchases",
    href: "/commercial/accounting?view=purchases",
    who: "finance",
    does: [
      "record a purchase from a supplier against a job",
      "see everything bought, grouped by vendor, job or month",
      "get one vendor's statement",
    ],
  },
  {
    name: "Accounting → Labor payments",
    href: "/commercial/accounting?view=labor-out",
    who: "finance",
    does: [
      "record a payment out to a crew or labor company",
      "see what has been paid to each crew",
    ],
  },
  {
    name: "Accounting → Deposits",
    href: "/commercial/accounting?view=deposits",
    who: "finance",
    does: ["see money in, grouped by the day it landed", "reconcile the bank"],
  },
  {
    name: "Accounting → AR aging",
    href: "/commercial/accounting?view=aging",
    who: "finance",
    does: ["see what is owed by how late it is — 30, 60, 90 days and beyond, per GC"],
  },
  {
    name: "Accounting → Sales tax",
    href: "/commercial/accounting?view=tax",
    who: "finance",
    does: ["see tax collected by rate, ready to file", "find invoices with no tax and no exemption on file"],
  },
  {
    name: "Accounting → Reimbursements",
    href: "/commercial/accounting?view=reimbursements",
    who: "finance",
    does: ["see who is owed money back out of pocket", "mark a reimbursement as paid"],
  },
  {
    name: "Accounting → Cash flow",
    href: "/commercial/accounting?view=cash",
    who: "finance",
    does: ["see collected against billed by month, and how long GCs take to pay"],
  },
  {
    name: "Accounting → Job costs",
    href: "/commercial/accounting?view=costs",
    who: "finance",
    does: ["see what each job has cost and what is left on it"],
  },
  {
    name: "Accounting → Transactions",
    href: "/commercial/accounting?view=transactions",
    who: "finance",
    does: ["the full ledger — everything in and out in one list"],
  },
  {
    name: "Accounting → Balance owed",
    href: "/commercial/accounting?view=owed",
    who: "finance",
    does: ["jobs that are finished or on hold with money still out — Tomco's own Balance Owed report"],
  },

  // ── Invoices ──────────────────────────────────────────────────────────────
  {
    name: "Invoices",
    href: "/commercial/invoices",
    does: [
      "raise a new invoice",
      "send an invoice to a GC",
      "see one invoice, its payments and its PDF",
      "void or edit an invoice",
    ],
  },

  // ── Sales ─────────────────────────────────────────────────────────────────
  {
    name: "Opportunities",
    href: "/commercial/opportunities",
    does: [
      "see every job and bid",
      "start a new opportunity",
      "find a job by name, GC or address",
      "move a job's stage",
    ],
  },
  {
    name: "A job's page",
    href: "/commercial/opportunities",
    does: [
      "everything about one job — its money, its documents, its team, its history",
      "raise a change order, an AIA application, a submittal, a work order, or the closeout",
      "the Project tab is where the delivery tools are",
    ],
  },
  {
    name: "Accounts (GCs)",
    href: "/commercial/accounts",
    does: ["see every GC", "add a contact", "see everything one GC has going with us"],
  },
  {
    name: "Reports → Pipeline",
    href: "/commercial/reports/pipeline",
    does: ["every open bid, what it is quoted at, and who to ring about it"],
  },
  {
    name: "Reports → Scheduling",
    href: "/commercial/reports/scheduling",
    does: ["jobs in coordination, on site or on hold, and what each still owes"],
  },
  {
    name: "Reports → Open Sales",
    href: "/commercial/reports/open-sales",
    does: ["every won job not yet closed out, with contract, tax, billed and balance"],
  },
  {
    name: "Reports → Win / Loss",
    href: "/commercial/reports/win-loss",
    does: ["how many bids were won and lost, and why"],
  },
  {
    name: "Reports → Jobs",
    href: "/commercial/reports/jobs",
    does: ["every job on one line — contract, billed, collected, cost, margin", "open one job's full report"],
  },
  {
    name: "Reports → Geography",
    href: "/commercial/reports/geography",
    does: ["where the work is — which towns, and what each is worth"],
  },
  {
    name: "Reports → Change orders",
    href: "/commercial/reports/change-orders",
    does: ["change orders raised, approved and billed, and spend by vendor"],
  },

  // ── Field ─────────────────────────────────────────────────────────────────
  {
    name: "Field Ops → Calendar",
    href: "/commercial/field-ops/calendar",
    who: "field",
    does: ["schedule a crew onto a job", "see who is where this week"],
  },
  {
    name: "Field Ops → Work Orders",
    href: "/commercial/field-ops/jobs",
    who: "field",
    does: ["see every job the crews are working", "change a job's status", "add a job"],
  },
  {
    name: "Field Ops → Status",
    href: "/commercial/field-ops/status",
    who: "field",
    does: ["move a job through its stages — estimating, scheduled, in progress, complete"],
  },
  {
    name: "Field Ops → Hours",
    href: "/commercial/field-ops/hours",
    who: "field",
    does: ["see hours logged by crew and day"],
  },
  {
    name: "Field Ops → Approvals",
    href: "/commercial/field-ops/approvals",
    who: "field",
    does: ["approve or question hours a foreman submitted"],
  },
  {
    name: "Field Ops → Crew",
    href: "/commercial/field-ops/employees",
    who: "field",
    does: ["add a crew member", "set somebody's cost rate", "give someone a clock-in PIN"],
  },
  {
    name: "Reports → Attendance",
    href: "/commercial/reports/attendance",
    does: ["who was on site, on which job, for how long — hours, not cost"],
  },

  // ── Everything else ───────────────────────────────────────────────────────
  {
    name: "Email",
    href: "/commercial/email",
    does: ["everything sent to and received from a GC, in one place", "check whether somebody replied"],
  },
  {
    name: "Reports",
    href: "/commercial/reports",
    does: ["every report, in folders — start here if you are not sure which one you want"],
  },
  {
    name: "Settings → Vendors",
    href: "/commercial/settings/vendors",
    who: "admin",
    does: ["add a vendor or a labor company", "mark a vendor retail or labor", "record a W-9"],
  },
  {
    name: "Settings",
    href: "/commercial/settings",
    who: "admin",
    does: [
      "add a user or change what they can see",
      "the company's own details on documents",
      "report folders and who can open them",
      "the signature used to counter-sign proposals",
    ],
  },
];

/** The map as the model sees it — compact, because it is sent on every ask. */
export function placesForPrompt(): string {
  return PLACES.map((p) => `${p.name} — ${p.href}${p.who ? ` [${p.who}]` : ""}\n  ${p.does.join("; ")}`).join("\n");
}
