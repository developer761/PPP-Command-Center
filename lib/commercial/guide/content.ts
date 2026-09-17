/**
 * "Running Commercial Work" — the handbook, as data.
 *
 * Karan 2026-09-16: "a walkthrough of basically how to do everything, a
 * specific page or two for Mary and her accounting page, simple and easy to
 * understand, with arrows and stuff."
 *
 * WHY THIS IS DATA AND NOT A DOCUMENT
 *
 * A printed guide starts lying the week after it is written, and nobody ever
 * notices — the page it names gets renamed, the button moves, and the handbook
 * carries on confidently sending people somewhere that no longer exists. So the
 * steps live here, every `page` is a real route, and `__tests__` walks the file
 * asserting each one still resolves. Rename a page and the suite goes red with
 * the handbook's own page number in the message.
 *
 * It also shares its map with the assistant: `places.ts` already lists every
 * surface and what you come to it to do. The two must agree — one of them
 * answering questions in the app and the other sitting in a drawer, disagreeing,
 * is worse than having neither.
 *
 * TONE: plain words, imperative, no jargon. The reader is a bookkeeper or a
 * painter, not a developer. "Press Record payment", not "submit the form".
 */

/** A drawn schematic — boxes and an arrow, never a screenshot. */
export type Sketch = {
  /** The row of things on screen, left to right. */
  boxes: string[];
  /** Which box the arrow points at (0-based). */
  arrowAt: number;
  /** What the arrow says. */
  arrowLabel: string;
};

export type Step = { n: number; text: string };

export type Task = {
  title: string;
  /** Where it happens — a real route, checked by the tests. */
  page: string;
  /** How to get there in words, for somebody who is not clicking a link. */
  path: string;
  steps: Step[];
  sketch?: Sketch;
  /** The thing that bites. Printed in an orange box. */
  watchOut?: string;
};

export type Section = {
  /** Page heading. */
  title: string;
  /** Who this page is for. */
  who: string;
  /** One sentence under the heading. */
  intro: string;
  tasks: Task[];
  /** Optional plain list — used where a table beats steps (the tab tour). */
  table?: { head: [string, string]; rows: [string, string][] };
  /** Closing line, printed small and grey. */
  footnote?: string;
};

// ── The shape of the whole thing ────────────────────────────────────────────

/** The job's journey, drawn across the top of the map page. */
export const JOURNEY: { label: string; sub: string }[] = [
  { label: "Bid", sub: "a GC asks for a price" },
  { label: "Proposal", sub: "we price it and send it" },
  { label: "Won", sub: "they accept" },
  { label: "On site", sub: "crew works, hours logged" },
  { label: "Billed", sub: "invoice or AIA goes out" },
  { label: "Paid", sub: "money in, job closed out" },
];

/** The five areas of the platform, for the map page. */
export const AREAS: { name: string; page: string; holds: string; who: string }[] = [
  {
    name: "Dashboard",
    page: "/commercial",
    holds: "What needs doing today, then the money at a glance.",
    who: "Everyone — start here",
  },
  {
    name: "Opportunities",
    page: "/commercial/opportunities",
    holds: "Every job and bid. Open one and everything about it is on its tabs.",
    who: "Sales and delivery",
  },
  {
    name: "Accounting",
    page: "/commercial/accounting",
    holds: "All the money — in, out, owed, and the sheets the bookkeeper gets.",
    who: "Mary",
  },
  {
    name: "Field Ops",
    page: "/commercial/field-ops/calendar",
    holds: "Who is on which job, hours logged, work orders.",
    who: "Brendan and the foremen",
  },
  {
    name: "Reports",
    page: "/commercial/reports",
    holds: "Every report in folders — the same ones Tomco ran in Salesforce.",
    who: "Alex and Brendan",
  },
];

// ── The sections, in the order they print ───────────────────────────────────

export const SECTIONS: Section[] = [
  // ══ MARY, pages 1–3 ═══════════════════════════════════════════════════════
  {
    title: "The Accounting page",
    who: "Mary",
    intro:
      "Everything to do with money is on this one page, behind tabs. You should not have to leave it during a normal day.",
    tasks: [],
    table: {
      head: ["Tab", "What it is for"],
      rows: [
        ["Overview", "The short version — what is owed, what came in, what the work cost."],
        ["Receivables", "Every job with money still out, and a note per line for what you have chased."],
        ["AR sheet", "The sheet you send on. Builds itself from the AIA applications you raise."],
        ["Purchases", "Record what was bought, and see it all grouped by vendor, job or month."],
        ["Labor payments", "Record what was paid out to a crew or labor company."],
        ["Deposits", "Money in, grouped by the day it landed. Use this to tick off the bank."],
        ["— More —", "The seven below are behind the More button. Nothing is hidden, just quieter."],
        ["Transactions", "The full ledger: everything in and out, in one list."],
        ["AR aging", "What is owed by how late it is — 30, 60, 90 days and beyond."],
        ["Cash flow", "Collected against billed by month, and how long each GC takes to pay."],
        ["Job costs", "What each job has cost and what is left on it."],
        ["Sales tax", "Tax collected by rate, ready to file."],
        ["Reimbursements", "Who is owed money back out of pocket."],
        ["Balance owed", "Finished or on-hold jobs with money still out — Tomco's own report."],
      ],
    },
    footnote:
      "Six tabs sit on the bar because you use them most days. The other seven are behind More. If you are already on one of them it stays open, so the bar can never hide where you are.",
  },

  {
    title: "Mary's three daily jobs",
    who: "Mary",
    intro: "Money in, money out for materials, money out for crew. Each is one form on the tab of the same name.",
    tasks: [
      {
        title: "Record a payment that came in",
        page: "/commercial/accounting?view=receivables",
        path: "Accounting → Receivables",
        sketch: {
          boxes: ["Overview", "Receivables", "AR sheet", "Purchases", "Labor", "Deposits"],
          arrowAt: 1,
          arrowLabel: "the payment form is at the top of this tab",
        },
        steps: [
          { n: 1, text: "Pick the invoice the cheque is for. Start typing the GC or the job to find it." },
          { n: 2, text: "Enter the amount, the date it was paid, and how (cheque, ACH, wire)." },
          { n: 3, text: "Press Record payment. A green line at the top confirms it." },
          { n: 4, text: "When it clears the bank, tick it off on the Deposits tab." },
        ],
        watchOut:
          "If you enter more than the invoice is owed, the platform caps it at the balance and tells you so in the green line. That means the bank and the platform now disagree — check the amount before moving on.",
      },
      {
        title: "Record a purchase",
        page: "/commercial/accounting?view=purchases",
        path: "Accounting → Purchases",
        sketch: {
          boxes: ["Overview", "Receivables", "AR sheet", "Purchases", "Labor", "Deposits"],
          arrowAt: 3,
          arrowLabel: "form at the top, everything bought below it",
        },
        steps: [
          { n: 1, text: "Choose the job it was bought for." },
          { n: 2, text: "Choose the category — materials, equipment, permit. The vendor list then shows only vendors for that category." },
          { n: 3, text: "Pick the vendor, enter the amount and the date." },
          { n: 4, text: "Put the receipt or reference number in the Reference box, then press Record." },
        ],
        watchOut:
          "Clicking a job name in the list below opens that job's costs tool, where you can add more against it. The back arrow at the top left says Purchases and brings you straight back here.",
      },
      {
        title: "Record a labor payment",
        page: "/commercial/accounting?view=labor-out",
        path: "Accounting → Labor payments",
        sketch: {
          boxes: ["Overview", "Receivables", "AR sheet", "Purchases", "Labor", "Deposits"],
          arrowAt: 4,
          arrowLabel: "paying a crew or labor company",
        },
        steps: [
          { n: 1, text: "Choose the job the crew worked on." },
          { n: 2, text: "Choose who was paid — the labor company, not the individual painter." },
          { n: 3, text: "Enter the amount and the date, then press Record." },
        ],
        watchOut:
          "Hours and payments are two different things and are never added together. The crew's HOURS are on Attendance; what you PAID them is here. Adding both would charge every job twice.",
      },
    ],
  },

  {
    title: "Mary's month end",
    who: "Mary",
    intro: "The three things that leave the building: the sheet for Alex, the pack for the bookkeeper, and the spreadsheet.",
    tasks: [
      {
        title: "The AR sheet — send it to Alex",
        page: "/commercial/accounting?view=ar",
        path: "Accounting → AR sheet",
        steps: [
          { n: 1, text: "The sheet builds itself from the AIA applications you have raised. You do not type it up." },
          { n: 2, text: "Check the lines. You can edit one, add one, or remove one if something is off." },
          { n: 3, text: "Press Send to email it, or Export for the spreadsheet." },
        ],
        watchOut:
          "Retention sits on its own line and is held until close-out. It is not late and must never be chased as overdue.",
      },
      {
        title: "A clean PDF for the bookkeeper",
        page: "/commercial/accounting",
        path: "Accounting → any tab → Print / PDF",
        sketch: {
          boxes: ["Print / PDF", "Export", "Send"],
          arrowAt: 0,
          arrowLabel: "prints the tab you are on, nothing else",
        },
        steps: [
          { n: 1, text: "Go to the tab you want to send." },
          { n: 2, text: "Press Print / PDF, top right." },
          { n: 3, text: "In the print box that opens, choose Save as PDF." },
        ],
        watchOut:
          "What prints is the report only — the tabs, filters and buttons are left off, and the sheet is headed with the company, the tab name and the date it was run.",
      },
      {
        title: "Export to a spreadsheet",
        page: "/commercial/accounting",
        path: "Accounting → any tab → Export",
        steps: [
          { n: 1, text: "Set any filters first — the file matches exactly what is on screen." },
          { n: 2, text: "Press Export. The file downloads." },
        ],
        watchOut: "Export always gives you the tab you are on. It is not always Receivables.",
      },
    ],
  },

  // ══ THE REST OF THE OFFICE ════════════════════════════════════════════════
  {
    title: "Sales — from a bid to a win",
    who: "Brendan and Alex",
    intro: "Everything about a job lives on the job. Open it once and work down its tabs.",
    tasks: [
      {
        title: "Start a new opportunity",
        page: "/commercial/opportunities",
        path: "Opportunities → New opportunity",
        steps: [
          { n: 1, text: "Press New opportunity." },
          { n: 2, text: "Pick the GC, name the job, and put in the address." },
          { n: 3, text: "Save. The job now has a page with all its tabs on it." },
        ],
      },
      {
        title: "Price it and send the proposal",
        page: "/commercial/opportunities",
        path: "The job → Proposals tab",
        sketch: {
          boxes: ["Overview", "Info", "Proposals", "Project", "Invoices", "Docs"],
          arrowAt: 2,
          arrowLabel: "pricing lives here, not on the job form",
        },
        steps: [
          { n: 1, text: "Open the job and go to Proposals." },
          { n: 2, text: "Build the proposal — scope lines, exclusions, tax." },
          { n: 3, text: "Send it for approval. Brendan signs it off before it reaches the GC." },
          { n: 4, text: "Once approved, send it to the GC from the same tab." },
        ],
        watchOut: "Bid low/high was removed from the job form. The proposal is where a job's price lives now.",
      },
      {
        title: "Mark it won or lost",
        page: "/commercial/opportunities",
        path: "The job → change the status",
        steps: [
          { n: 1, text: "Change the job's status to Won or Lost." },
          { n: 2, text: "On a loss, record why and who we lost to." },
          { n: 3, text: "File the debrief. It is two minutes and it is the whole Win/Loss report." },
        ],
        watchOut:
          "Record the win the day the GC says yes, even if the paperwork lands next week. A late win date makes every report wrong.",
      },
    ],
  },

  {
    title: "Delivery — getting it done",
    who: "Brendan and the foremen",
    intro: "A won job becomes a work order, gets a crew, and logs hours.",
    tasks: [
      {
        title: "Raise the work order",
        page: "/commercial/opportunities",
        path: "The job → Project tab → Work Orders",
        sketch: {
          boxes: ["Change orders", "AIA", "Submittals", "Work orders", "Transactions", "Closeout"],
          arrowAt: 3,
          arrowLabel: "the delivery tools are on the Project tab",
        },
        steps: [
          { n: 1, text: "Open the job and go to the Project tab." },
          { n: 2, text: "Open Work Orders and raise one." },
          { n: 3, text: "Send it to the crew." },
        ],
      },
      {
        title: "Put a crew on it",
        page: "/commercial/field-ops/calendar",
        path: "Field Ops → Calendar",
        steps: [
          { n: 1, text: "Find the week and the job." },
          { n: 2, text: "Add the crew to the day." },
          { n: 3, text: "The crew get their schedule by email — in Spanish where that is their language." },
        ],
      },
      {
        title: "Hours",
        page: "/commercial/field-ops/hours",
        path: "Field Ops → Hours, then Approvals",
        steps: [
          { n: 1, text: "Foremen submit the hours their crew worked." },
          { n: 2, text: "Check them under Approvals — approve, or question one." },
        ],
        watchOut:
          "Hours are a record of who was on site. They are not what the crew is paid — that is a labor payment Mary records. The two are kept apart on purpose.",
      },
    ],
  },

  {
    title: "Billing — getting the money out",
    who: "Mary and Katie",
    intro: "Two ways to bill, and they are not interchangeable. The GC's contract decides which.",
    tasks: [
      {
        title: "A normal invoice",
        page: "/commercial/invoices",
        path: "Invoices → New invoice",
        steps: [
          { n: 1, text: "Raise the invoice against the job." },
          { n: 2, text: "Check the tax line, then send it to the GC." },
          { n: 3, text: "It now appears on Receivables until it is paid." },
        ],
      },
      {
        title: "An AIA application (G702/G703)",
        page: "/commercial/opportunities",
        path: "The job → Project tab → AIA",
        steps: [
          { n: 1, text: "Open the job's Project tab and go to AIA." },
          { n: 2, text: "Raise the next application — the percentages carry forward from the last one." },
          { n: 3, text: "Issue it. It lands on the AR sheet by itself." },
        ],
        watchOut:
          "An AIA job raises no invoice, so it will not show on lists that only count invoices. The AR sheet and Receivables both include it.",
      },
      {
        title: "A change order",
        page: "/commercial/opportunities",
        path: "The job → Project tab → Change orders",
        steps: [
          { n: 1, text: "Raise the change order and get it approved." },
          { n: 2, text: "Once approved it is added to the contract, so it can be billed." },
        ],
        watchOut: "An unapproved change order is not money. It is not in the contract until the GC signs it.",
      },
    ],
  },

  {
    title: "Closing a job out",
    who: "Brendan",
    intro: "The last mile — the pack the GC needs, and the warranty that starts the clock.",
    tasks: [
      {
        title: "The closeout packet",
        page: "/commercial/opportunities",
        path: "The job → Project tab → Closeout",
        steps: [
          { n: 1, text: "Open Closeout on the job's Project tab." },
          { n: 2, text: "Work down the list — it tells you what is still missing." },
          { n: 3, text: "Issue the warranty. Twelve months from substantial completion." },
        ],
        watchOut:
          "Retention is released at close-out. Until the job is closed out, that money is not late and should not be chased.",
      },
    ],
  },
];

// ── The index, printed last ─────────────────────────────────────────────────

/**
 * "Where do I…" — the page somebody actually turns to.
 *
 * Deliberately phrased as the question people ask out loud, not as the name of
 * a feature: somebody looking for Receivables does not think "receivables",
 * they think "who still owes us".
 */
export const LOOKUP: { question: string; answer: string }[] = [
  { question: "…record a payment that came in?", answer: "Accounting → Receivables" },
  { question: "…record something we bought?", answer: "Accounting → Purchases" },
  { question: "…pay a crew?", answer: "Accounting → Labor payments" },
  { question: "…see who still owes us?", answer: "Accounting → Receivables" },
  { question: "…see how late the money is?", answer: "Accounting → AR aging" },
  { question: "…tick off the bank?", answer: "Accounting → Deposits" },
  { question: "…send the sheet to Alex?", answer: "Accounting → AR sheet → Send" },
  { question: "…get a clean PDF for the bookkeeper?", answer: "Accounting → the tab → Print / PDF" },
  { question: "…see what a job has cost?", answer: "Accounting → Job costs" },
  { question: "…file sales tax?", answer: "Accounting → Sales tax" },
  { question: "…pay somebody back out of pocket?", answer: "Accounting → Reimbursements" },
  { question: "…start a new job?", answer: "Opportunities → New opportunity" },
  { question: "…price a job?", answer: "The job → Proposals" },
  { question: "…raise an invoice?", answer: "Invoices → New invoice" },
  { question: "…raise an AIA application?", answer: "The job → Project → AIA" },
  { question: "…raise a change order?", answer: "The job → Project → Change orders" },
  { question: "…raise a work order?", answer: "The job → Project → Work orders" },
  { question: "…close a job out?", answer: "The job → Project → Closeout" },
  { question: "…schedule a crew?", answer: "Field Ops → Calendar" },
  { question: "…add a crew member?", answer: "Field Ops → Crew" },
  { question: "…approve hours?", answer: "Field Ops → Approvals" },
  { question: "…see who was on site?", answer: "Reports → Attendance" },
  { question: "…see every open bid?", answer: "Reports → Pipeline" },
  { question: "…see what we won and lost?", answer: "Reports → Win / Loss" },
  { question: "…add a vendor?", answer: "Settings → Vendors" },
  { question: "…give somebody a login?", answer: "Settings → Access" },
  { question: "…check whether a GC replied?", answer: "Email" },
  { question: "…ask a question about any of this?", answer: "Press Ask, bottom right of any page" },
];

/** Every route the handbook points at, for the test that keeps it honest. */
export function guideRoutes(): string[] {
  const out = AREAS.map((a) => a.page);
  for (const s of SECTIONS) for (const t of s.tasks) out.push(t.page);
  return [...new Set(out)];
}
