import type { RoleGuide, RoleKey } from "./walkthrough";

/**
 * The four walkthroughs.
 *
 * Every `label` in a `controls` list is the text printed on the control, taken
 * from the component that renders it — not a description of it. That is what
 * makes this usable by somebody staring at the screen, and it is also the part
 * most likely to rot, so the labels are quoted rather than paraphrased and the
 * tests hold every `href` to a real page.
 */

/**
 * The job's journey, drawn across the top of the printed map page.
 *
 * Lives here rather than in the PDF because the screen and the paper must tell
 * the same story; two copies of "how a job moves" is two things to keep in step.
 */
export const JOURNEY: { label: string; sub: string }[] = [
  { label: "Bid", sub: "a GC asks for a price" },
  { label: "Proposal", sub: "we price it and send it" },
  { label: "Won", sub: "they accept" },
  { label: "On site", sub: "crew works, hours logged" },
  { label: "Billed", sub: "invoice or AIA goes out" },
  { label: "Paid", sub: "money in, job closed out" },
];

/**
 * "Where do I…" — the page somebody actually turns to.
 *
 * Phrased as the question people ask out loud, not as the name of a feature:
 * somebody looking for Receivables does not think "receivables", they think
 * "who still owes us".
 */
export const LOOKUP: { question: string; answer: string }[] = [
  { question: "…record a payment that came in?", answer: "Accounting › Receivables" },
  { question: "…record something we bought?", answer: "Accounting › Purchases" },
  { question: "…attach a receipt to it?", answer: "The Receipt box on that same form" },
  { question: "…add a receipt to a purchase already saved?", answer: "The job › Project › Costs › Edit" },
  { question: "…pay a crew?", answer: "Accounting › Labor payments" },
  { question: "…see who still owes us?", answer: "Accounting › Receivables" },
  { question: "…tick a payment off against the bank?", answer: "Accounting › Transactions" },
  { question: "…see how late the money is?", answer: "Accounting › AR aging" },
  { question: "…send the sheet to Alex?", answer: "Accounting › AR sheet" },
  { question: "…get a clean PDF for the bookkeeper?", answer: "Accounting › the tab › Print / PDF" },
  { question: "…see what a job has cost?", answer: "Accounting › Job costs" },
  { question: "…file sales tax?", answer: "Accounting › Sales tax" },
  { question: "…pay somebody back out of pocket?", answer: "Accounting › Reimbursements" },
  { question: "…start a new job?", answer: "Opportunities › New opportunity" },
  { question: "…price a job?", answer: "The job › Proposals" },
  { question: "…get a proposal approved?", answer: "The job › Proposals › Send for approval" },
  { question: "…send a proposal to the GC?", answer: "The job › Proposals › Send proposal" },
  { question: "…raise a submittal?", answer: "The job › Project › Submittals" },
  { question: "…raise a change order?", answer: "The job › Project › Change Orders" },
  { question: "…raise an AIA application?", answer: "The job › Project › AIA Billing" },
  { question: "…write a work order?", answer: "The job › Project › Work Order" },
  { question: "…close a job out?", answer: "The job › Project › Closeout & Warranty" },
  { question: "…issue the warranty?", answer: "The job › Project › Closeout & Warranty" },
  { question: "…schedule a crew?", answer: "Field Ops › Calendar" },
  { question: "…add a crew member?", answer: "Field Ops › Crew" },
  { question: "…approve hours?", answer: "Field Ops › Approvals" },
  { question: "…see who was on site?", answer: "Reports › Attendance" },
  { question: "…see every open bid?", answer: "Reports › Pipeline" },
  { question: "…see what we won and lost?", answer: "Reports › Win / Loss" },
  { question: "…add a vendor?", answer: "Settings › Vendors" },
  { question: "…give somebody a login?", answer: "Settings › Access" },
  { question: "…ask a question about any of this?", answer: "Press Ask, bottom right of any page" },
];

/** The Accounting tab bar, as it reads on screen. Used by Mary's chapters. */
const ACCOUNTING_BAR = ["Overview", "Receivables", "AR sheet", "Purchases", "Labor payments", "Deposits"];

const OVERVIEW: RoleGuide = {
  key: "overview",
  label: "Everything",
  tagline: "The whole platform, shallow",
  intro:
    "The short version of the whole thing — what each area is for and roughly how a job moves through it. If you are new, read this first, then switch to your own name above for the detail.",
  chapters: [
    {
      id: "journey",
      title: "How a job moves",
      blurb:
        "Bid, proposal, won, on site, billed, paid. Everything in the platform is somewhere on that line, and every area below owns one stretch of it.",
      surfaces: [
        {
          name: "Dashboard",
          href: "/commercial",
          path: "Dashboard",
          purpose:
            "Where everyone starts. The top of the page is what needs doing today — late invoices, work finished and not billed, bids past their date — each one a link straight to where you do it. The figures sit underneath.",
          controls: [
            { label: "What needs doing", does: "The work list. Rows are ranked by how much money is at risk, biggest first." },
            { label: "Ask", does: "Bottom right of every page. Type a question in your own words and it tells you where to go." },
          ],
        },
        {
          name: "Opportunities",
          href: "/commercial/opportunities",
          path: "Opportunities",
          purpose:
            "Every job and bid there has ever been. Open one and everything about it is on its tabs — the price, the money, the paperwork, the crew, the history.",
        },
        {
          name: "Accounting",
          href: "/commercial/accounting",
          path: "Accounting",
          purpose:
            "All the money, on one page behind tabs: what is owed, what came in, what went out, and the sheets that get sent to the bookkeeper. This is Mary's desk.",
        },
        {
          name: "Field Ops",
          href: "/commercial/field-ops/calendar",
          path: "Field Ops",
          purpose: "Who is on which job this week, the hours they logged, and the work orders behind it.",
        },
        {
          name: "Reports",
          href: "/commercial/reports",
          path: "Reports",
          purpose:
            "Every report, in folders — the same ones Tomco ran in Salesforce, rebuilt record for record. Each one opens with its rows and puts the charts underneath.",
        },
        {
          name: "Settings",
          href: "/commercial/settings",
          path: "Settings",
          purpose:
            "The company's details on documents, the vendor list, who can log in and what they can see, and which reports each person can open.",
        },
      ],
    },
  ],
};

const MARY: RoleGuide = {
  key: "mary",
  label: "Mary",
  tagline: "The money",
  intro:
    "Everything to do with money is on the Accounting page, behind tabs. On a normal day you should not have to leave it: record what came in, record what went out, and at month end send the sheets on.",
  chapters: [
    {
      id: "mary-day",
      title: "Every day",
      blurb: "Money in, money out for materials, money out for crew. Three tabs, one form each.",
      surfaces: [
        {
          name: "Receivables",
          href: "/commercial/accounting?view=receivables",
          path: "Accounting › Receivables",
          tourTarget: "accounting:record-payment",
          purpose:
            "Every job with money still out, and the form for recording a payment when it comes in. Each row carries a note so anyone can see what has been chased and when.",
          strip: { boxes: ACCOUNTING_BAR, at: 1 },
          steps: [
            "In the left-hand menu, click Accounting.",
            "Click the Receivables tab, second along the top bar.",
            "The form Record a payment is at the top of the page.",
            "Click the Invoice box and start typing the GC or the job name, then pick the invoice from the list.",
            "Type the Amount — just the number, no dollar sign.",
            "Set Date received. It already says today, so only change it if the payment came in earlier.",
            "Choose the Method — Check, ACH / wire, Card, Cash or Other.",
            "Put the check or wire number in Reference.",
            "Click Record payment. A green line appears at the top to confirm.",
            "Later, when it clears the bank: click More, then Transactions, find the row and click Mark.",
          ],
          controls: [
            { label: "Invoice", tourTarget: "pay:invoice_id", kind: "field", required: true, does: "Search by job name or invoice number. This is what the payment lands against." },
            { label: "Amount", tourTarget: "pay:amount", kind: "field", required: true, does: "What actually came in." },
            { label: "Date received", tourTarget: "pay:paid_at", kind: "field", required: true, does: "The day it was paid. Defaults to today." },
            { label: "Method", tourTarget: "pay:method", kind: "field", does: "Check, ACH / wire, Card, Cash or Other. Defaults to Check." },
            { label: "Reference", tourTarget: "pay:reference", kind: "field", does: "Check number or wire reference — what you match against the paperwork later." },
            { label: "Record payment", does: "Saves it against the invoice, the job and the deposit list at once." },
            { label: "Collection note", kind: "field", does: "What you have chased and when, per row. Everyone can see it." },
            { label: "Save", does: "Saves that row's note without losing your place in the list." },
            { label: "Overdue only", kind: "filter", does: "Hides everything that is not yet late." },
            { label: "Clear", kind: "link", does: "Drops every filter at once. Only appears when something is filtered." },
            { label: "Export", does: "Downloads this tab as a spreadsheet, matching the filters you have set." },
            { label: "Print / PDF", does: "Prints the report only — no tabs, no filters, no buttons — headed with the company and the date." },
            { label: "Send", does: "Emails the receivables sheet. Hover it to see who it goes to. It sends the whole book, not your filter." },
          ],
          watchOut:
            "If you enter more than the invoice is owed, the platform caps it at the balance and says so in the green line. That means the bank and the platform now disagree — check the amount before moving on.",
        },
        {
          name: "Purchases",
          href: "/commercial/accounting?view=purchases",
          path: "Accounting › Purchases",
          tourTarget: "accounting:record-purchase",
          purpose:
            "Record what was bought against a job, and see everything bought grouped by vendor, by job or by month.",
          strip: { boxes: ACCOUNTING_BAR, at: 3 },
          steps: [
            "In the left-hand menu, click Accounting.",
            "Click the Purchases tab on the top bar.",
            "The form Record a purchase is at the top of the page.",
            "Click the Job box and start typing the job name, then pick it from the list.",
            "Click the Vendor box and pick the supplier. If they are not on the list, just type the name in.",
            "Type the Amount, and set the Date it was bought.",
            "Choose the Category — Materials, Equipment, Permit or Other.",
            "Put the receipt or invoice number in Reference.",
            "TO ADD THE RECEIPT ITSELF: click the Receipt box at the bottom of the form and choose the file. On a phone this opens the camera, so you can photograph the docket there and then.",
            "Click Record purchase. It appears in the list below straight away, with a tick in the Receipt column.",
          ],
          controls: [
            { label: "Job", tourTarget: "purchase:opportunity_id", kind: "field", required: true, does: "Search jobs. What the purchase is booked against." },
            { label: "Vendor", tourTarget: "purchase:vendor", kind: "field", required: true, does: "Search vendors, or type a new one straight in." },
            { label: "Amount", tourTarget: "purchase:amount", kind: "field", required: true, does: "What it cost." },
            { label: "Date", tourTarget: "purchase:purchased_at", kind: "field", required: true, does: "When it was bought. Defaults to today." },
            { label: "Category", tourTarget: "purchase:category", kind: "field", does: "Materials, Equipment, Permit or Other. Defaults to Materials. Crew labor is not here — it goes on the Labor payments tab." },
            { label: "Reference", tourTarget: "purchase:description", kind: "field", does: "Receipt or invoice number." },
            { label: "Reimburse to", tourTarget: "purchase:reimburse_to", kind: "field", does: "Only fill this in when somebody paid out of pocket. It then shows on the Reimbursements tab until you mark it paid." },
            { label: "Receipt", tourTarget: "purchase:receipt", kind: "field", does: "The receipt itself — a photo or a PDF. On a phone it opens the camera. Optional, but it is what the Receipt column in the list below is ticking." },
            { label: "Record purchase", does: "Books it against the job's costs and adds it to the list below straight away." },
            { label: "The job name in the list", kind: "link", does: "Opens that job's costs tool, where you can add more against it. The back arrow there says Purchases and brings you straight back." },
          ],
          watchOut:
            "Category has no Labor option on purpose. Paying a crew is the Labor payments tab, which books it as a Subcontract cost — recording it here would put crew money in with materials.",
        },
        {
          name: "Labor payments",
          href: "/commercial/accounting?view=labor-out",
          path: "Accounting › Labor payments",
          tourTarget: "accounting:record-labor",
          purpose: "Record what was paid out to a crew or labor company, and see what each has been paid.",
          strip: { boxes: ACCOUNTING_BAR, at: 4 },
          steps: [
            "In the left-hand menu, click Accounting.",
            "Click the Labor payments tab on the top bar.",
            "The form Record a labor payment is at the top of the page.",
            "Click the Job box and pick the job the crew worked on.",
            "Click Paid to and pick the crew or labor company — the company, not the individual painter.",
            "Type the Amount and set Date paid.",
            "Click Record payment out.",
          ],
          controls: [
            { label: "Job", tourTarget: "labor:opportunity_id", kind: "field", required: true, does: "Which job the crew worked on." },
            { label: "Paid to", tourTarget: "labor:vendor", kind: "field", required: true, does: "The crew or labor company. You can type a new one straight in." },
            { label: "Amount", tourTarget: "labor:amount", kind: "field", required: true, does: "What was paid out." },
            { label: "Date paid", tourTarget: "labor:purchased_at", kind: "field", required: true, does: "Defaults to today." },
            { label: "Hours", tourTarget: "labor:hours", kind: "field", does: "Optional, and only a note on the payment. It is not the crew's attendance — that is logged in Field Ops." },
            { label: "Reference", tourTarget: "labor:description", kind: "field", does: "Check number, or what the payment covered." },
            { label: "Record payment out", does: "Books it against the job as a Subcontract cost, which is where crew labor is counted." },
          ],
          watchOut:
            "Hours and payments are two different things and are never added together. The crew's HOURS are on Attendance; what you PAID them is here. Adding both would charge every job twice.",
        },
        {
          name: "Deposits",
          href: "/commercial/accounting?view=deposits",
          path: "Accounting › Deposits",
          tourTarget: "accounting:deposits",
          purpose:
            "Money in, grouped by the day it landed — the view you read with the bank statement next to you. Job names link to where that payment was recorded.",
          strip: { boxes: ACCOUNTING_BAR, at: 5 },
          watchOut:
            "This tab shows the deposits; it does not tick them off. The Mark button is on the Transactions tab, behind More.",
        },
      ],
    },
    {
      id: "mary-month",
      title: "Month end",
      blurb: "The three things that leave the building.",
      surfaces: [
        {
          name: "AR sheet",
          href: "/commercial/accounting?view=ar",
          path: "Accounting › AR sheet",
          tourTarget: "accounting:ar",
          purpose:
            "The sheet you send on, headed \u201cAccounts Receivable\u201d. It builds itself from the AIA applications that have been raised — you do not type it up. Retention sits on its own line, and every line groups under its job with a subtotal.",
          strip: { boxes: ACCOUNTING_BAR, at: 2 },
          controls: [
            { label: "Edit the sheet", does: "Opens the editor underneath the table. Everything below is inside it." },
            { label: "Add line", does: "Puts a line on the sheet that has no application behind it yet. Needs a Job and a Billed / open figure." },
            { label: "Save", does: "Saves your changes to one carried-over line." },
            { label: "Remove", does: "Takes a line off this sheet only — do this once its certificate has been raised here. It deletes nothing on the job." },
            { label: "Export", does: "Downloads the AR sheet as a spreadsheet — the file that goes to Alex." },
          ],
          watchOut:
            "Retention is held until close-out. It is not late, and it must never be chased as overdue. Only carried-over lines can be edited — a line generated from a certificate is changed on the job, not here.",
        },
        {
          name: "Any tab › Print / PDF",
          href: "/commercial/accounting",
          path: "Accounting › any tab › Print / PDF",
          tourTarget: "accounting:print",
          purpose:
            "A clean sheet for the bookkeeper. What prints is the report and its figures — the tab strip, the filter bars and the entry forms are all left off, and the page is headed with the company name, the tab and the date it was run.",
          steps: [
            "Open the tab you want to send — Receivables, AR sheet, whichever it is.",
            "Click Print / PDF at the top right of the page.",
            "Your browser's print box opens. Change the Destination to Save as PDF.",
            "Click Save, and choose where to put the file.",
          ],
        },
      ],
    },
    {
      id: "mary-questions",
      title: "When someone asks a question",
      blurb: "The tabs behind More answer most of them. Nothing is hidden, just quieter.",
      surfaces: [
        {
          name: "AR aging",
          href: "/commercial/accounting?view=aging",
          path: "Accounting › More › AR aging",
          tourTarget: "accounting:aging",
          purpose: "What is owed by how late it is — 30, 60, 90 days and beyond, per GC. The answer to “how bad is it”.",
        },
        {
          name: "Cash flow",
          href: "/commercial/accounting?view=cash",
          path: "Accounting › More › Cash flow",
          tourTarget: "accounting:cash",
          purpose: "Collected against billed by month, and how long each GC actually takes to pay.",
        },
        {
          name: "Job costs",
          href: "/commercial/accounting?view=costs",
          path: "Accounting › More › Job costs",
          tourTarget: "accounting:costs",
          purpose: "What each job has cost and what is left on it. Clicking a job opens its costs tool.",
        },
        {
          name: "Sales tax",
          href: "/commercial/accounting?view=tax",
          path: "Accounting › More › Sales tax",
          tourTarget: "accounting:tax",
          purpose: "Tax collected by rate, ready to file — and the invoices that carried no tax and have no exemption on file.",
          controls: [
            { label: "Issued", kind: "filter", does: "Narrows to invoices issued in a period — this quarter, this year, and so on." },
            { label: "Show just those", kind: "link", does: "In the warning banner: filters to the invoices with no exemption certificate on file." },
            { label: "Export for filing", does: "Downloads the sheet in the shape the filing needs." },
          ],
        },
        {
          name: "Transactions",
          href: "/commercial/accounting?view=transactions",
          path: "Accounting › More › Transactions",
          tourTarget: "accounting:transactions",
          purpose:
            "The full ledger: everything in and out, newest month first, with a subtotal per month. This is also where you tick payments off against the bank.",
          controls: [
            { label: "Mark", does: "Ticks a payment as cleared the bank. One click, no save button." },
            { label: "Deposited", does: "What a ticked payment reads instead. Press it again to untick — a deposit that bounced has to be reversible." },
            { label: "Not deposited", kind: "filter", does: "Shows only money received that has not cleared yet — the money sitting in the office." },
            { label: "Export ledger", does: "Downloads the ledger with its own filters applied, which the page-level Export does not carry." },
          ],
        },
        {
          name: "Balance owed",
          href: "/commercial/accounting?view=owed",
          path: "Accounting › More › Balance owed",
          tourTarget: "accounting:owed",
          purpose:
            "Jobs that are finished or on hold with money still out — Tomco's own Balance Owed report, the same records to the cent.",
        },
        {
          name: "Reimbursements",
          href: "/commercial/accounting?view=reimbursements",
          path: "Accounting › More › Reimbursements",
          tourTarget: "accounting:reimbursements",
          purpose: "Who is owed money back out of pocket. A purchase reaches this tab when somebody filled in Reimburse to.",
          controls: [
            { label: "Mark paid", does: "Moves a line from Still owed to Paid back. One click." },
            { label: "Undo", does: "Puts it back on Still owed if you ticked the wrong one." },
          ],
        },
      ],
    },
  ],
};

/** Filled from the surface inventory — see roles-delivery.ts. */
import { BRENDAN, STEPHANIE } from "./roles-delivery";

export const ROLES: RoleGuide[] = [OVERVIEW, MARY, BRENDAN, STEPHANIE];

export function roleFor(key: string | undefined): RoleGuide {
  return ROLES.find((r) => r.key === key) ?? OVERVIEW;
}

export type { RoleKey };
