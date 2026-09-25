import type { RoleGuide, RoleKey } from "./walkthrough";
import {
  ACCOUNTING_PRIMARY_LABELS,
  ACCOUNTING_VIEWS,
  accountingTabIndex,
} from "@/lib/commercial/accounting/tabs";

/** How many views the Accounting page has in total — bar plus behind More. */
const ACCOUNTING_VIEW_COUNT = ACCOUNTING_VIEWS.length;

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

/**
 * The Accounting tab bar the handbook draws, taken from the bar itself.
 *
 * It used to be a hand-typed copy and it went stale: Payroll landed on the
 * real page on 2026-09-24 and Balance owed before it, and neither appeared
 * here — so Mary's chapter, the one titled "The money", drew a bar that was
 * missing two tabs and highlighted the wrong one on every surface after
 * Receivables. Somebody counting along to "the third tab" pressed AR sheet.
 */
const ACCOUNTING_BAR = ACCOUNTING_PRIMARY_LABELS;

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
          steps: [
            "This is the page you land on.",
            "Read What needs doing at the top — it is ordered by money at risk.",
            "Click any row to go straight to where that job gets done.",
          ],
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
          steps: [
            "Click Opportunities in the left menu.",
            "Type in the search box to find a job by name, GC or address.",
            "Click a job to open everything about it.",
          ],
        },
        {
          name: "Accounting",
          href: "/commercial/accounting",
          path: "Accounting",
          purpose:
            "All the money, on one page behind tabs: what is owed, what came in, what went out, and the sheets that get sent to the bookkeeper. This is Mary's desk.",
          steps: [
            "Click Accounting in the left menu.",
            // Counted, not typed. It read "Six tabs … the other seven" while
            // the bar had eight, because both numbers were written by hand in
            // 2026-08 and two tabs were added after.
            `${ACCOUNTING_PRIMARY_LABELS.length} tabs sit on the bar. Click More for the other ${ACCOUNTING_VIEW_COUNT - ACCOUNTING_PRIMARY_LABELS.length}.`,
          ],
        },
        {
          name: "Field Ops",
          href: "/commercial/field-ops/calendar",
          path: "Field Ops",
          purpose: "Who is on which job this week, the hours they logged, and the work orders behind it.",
          steps: [
            "Click Field Ops in the left menu.",
            "Pick Calendar, Work Orders, Hours, Approvals or Crew.",
          ],
        },
        {
          name: "Reports",
          href: "/commercial/reports",
          path: "Reports",
          purpose:
            "Every report, in folders — the same ones Tomco ran in Salesforce, rebuilt record for record. Each one opens with its rows and puts the charts underneath.",
          steps: [
            "Click Reports in the left menu.",
            "Open a folder, then the report you want.",
            "Every report has an Export button.",
          ],
        },
        {
          name: "Settings",
          href: "/commercial/settings",
          path: "Settings",
          purpose:
            "The company's details on documents, the vendor list, who can log in and what they can see, and which reports each person can open.",
          steps: [
            "Click Settings in the left menu.",
            "Pick the card for what you want to change.",
          ],
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
    /**
     * PAYROLL COMES FIRST because it is the only thing on this page with a
     * deadline. Karan 2026-09-24: "put payroll tab before receivables" — the
     * rest of Accounting is things you look up; this is a thing that is due.
     *
     * It was missing from this handbook entirely. The chapter titled "The
     * money", claiming to be Mary's whole day, did not mention the tab she
     * runs the week from.
     */
    {
      id: "mary-week",
      title: "Every week",
      blurb:
        "Payroll, in one place and in one order: hours out to Gusto, what Gusto charged back in, then onto the jobs.",
      surfaces: [
        {
          name: "Payroll",
          href: "/commercial/accounting?view=payroll",
          path: "Accounting › Payroll",
          tourTarget: "payroll:hours",
          purpose:
            "The week's approved hours to send to Gusto, the real cost Gusto took out of the bank, and the two joined up so every job carries its share of the labor. One tab, start to finish.",
          /**
           * NO TAB STRIP ON THIS SURFACE, DELIBERATELY — the printed handbook
           * cannot take another one.
           *
           * Adding a strip here (any strip: 6 boxes or 8, any highlighted
           * index, with or without wrap={false}) sends react-pdf into a
           * runaway page-height search. It doubles the page height about
           * twenty times — 19,355,170 then 1,088,727,936 and so on — until the
           * absolutely-positioned footer lands at top: -1.9e21 and pdfkit
           * throws `unsupported number`. The whole handbook fails to render,
           * and nothing in the message mentions a strip, a page, or this file.
           *
           * It is cumulative, not about this strip: with the two new sections
           * here carrying no strip the document renders, and the five older
           * strips are untouched. So this is a ceiling in the PDF layout, not
           * a fault in the content, and it is worth real time with react-pdf
           * rather than a guess at midnight.
           *
           * Nothing is lost for the reader: the `path` line above already
           * reads "Accounting › Payroll", which is the instruction. The strip
           * is a picture of it.
           *
           * `guide-sections-dont-start-at-a-page-foot` renders the real PDF
           * and is what caught this before it shipped — it is the guard that
           * matters here, so do not skip it when adding to this file.
           */
          steps: [
            "Click Accounting in the left menu.",
            "Click the Payroll tab. It opens on the last week that has hours.",
            "Check the week in the middle of the arrows. Use ‹ and › to move, or This week to jump back.",
            "Read Hours this week. This is APPROVED time only — anything still unapproved is not here.",
            "If someone is missing, the panel says so by name. Click check approvals and approve their hours first.",
            "Click Copy hours for Gusto and paste it into Gusto. Run payroll there.",
            "Come back here. In Actual cost from Gusto, type what Gusto took out of the bank for each person.",
            "Faster: click Paste a column from Gusto and paste the whole column in one go.",
            "Click Save Gusto costs.",
            "Read Job cost allocation — each person's cost split across the jobs they worked, by hours.",
            "Click Post to job costs.",
          ],
          controls: [
            { label: "‹ and ›", kind: "button", does: "Moves back and forward a week. The dates between them are the week you are working on." },
            { label: "This week", kind: "link", does: "Jumps to the current week. Only shows when you are looking at a different one." },
            { label: "Hours this week", tourTarget: "payroll:hours", does: "Approved hours per person, split into ON JOBS and NOT ON A JOB, with how many jobs each worked. The total at the bottom is what Gusto should be paying for." },
            { label: "check approvals", kind: "link", does: "Appears only when somebody has no approved hours this week. Opens the approvals screen so you can fix it before payroll goes out." },
            { label: "Copy hours for Gusto", kind: "button", does: "Puts the hours on your clipboard in Gusto's column order. The text stays on screen and selectable, so you can copy it by hand if the clipboard is blocked." },
            { label: "Actual cost from Gusto", tourTarget: "payroll:gusto-costs", kind: "field", does: "What Gusto took out of the BANK for each person — wages plus payroll taxes, not the gross on their payslip. This is the number the jobs get charged." },
            { label: "Paste a column from Gusto", kind: "button", does: "Paste the whole column in one go instead of typing each person. It shows you what it read before anything is saved, so a column that is one row short is obvious now rather than next month." },
            { label: "Save Gusto costs", does: "Saves the figures. It does not touch the jobs yet — that is the next button." },
            { label: "Job cost allocation", tourTarget: "payroll:allocation", does: "Each person's cost spread across the jobs they worked, in proportion to hours. This is the split that gets written." },
            { label: "Labor detail", tourTarget: "payroll:labor-detail", does: "The same thing the other way round — per job, who worked it, what they cost and the loaded rate per hour." },
            { label: "Post to job costs", does: "Writes a labor payout onto each job, exactly like a crew payment. Greyed out until the costs are in, and it tells you what it is waiting for." },
          ],
          watchOut:
            "Enter what Gusto took out of the bank, not the gross wage. The gross leaves the payroll taxes off every job, so margins read better than they are. And posting a week twice REPLACES what it wrote last time rather than adding to it — the confirmation says which.",
        },
      ],
    },
    {
      id: "mary-day",
      title: "Every day",
      blurb: "Money in, money out for materials, money out for crew. Three tabs, one form each.",
      surfaces: [
        /** Where the page opens, and the only tab nobody had written down. */
        {
          name: "Overview",
          href: "/commercial/accounting?view=overview",
          path: "Accounting › Overview",
          purpose:
            "Where Accounting opens: what is owed, who owes most of it, how long it is taking to arrive, and what the work actually cost. Nothing is entered here — every figure is a way in to the tab that holds the detail.",
          // See the note on the Payroll surface: no strip, or the handbook PDF will not render.
          steps: [
            "Click Accounting in the left menu. This is the tab it opens on.",
            "Read the four boxes across the top — they stay there on every tab.",
            "Read the yellow line: how much of the book sits with one GC.",
            "Click See just them to filter Receivables down to that GC.",
            "Read Won, not invoiced — work finished with no bill raised. Click it for the list.",
            "Scroll to Biggest outstanding for the largest open items, newest chase first.",
            "Scroll to What the work cost for margin and the cost mix.",
          ],
          controls: [
            { label: "Total outstanding", does: "Everything still owed, with how many items and how much of it is past due." },
            { label: "Biggest GC", does: "The GC holding the most of it, and what share of the whole book that is." },
            { label: "Over 90 days", does: "The money that is properly late. This is the number to chase first." },
            { label: "Oldest", does: "The single longest-waiting item, named, so it is not just a statistic." },
            { label: "See just them", kind: "link", does: "Opens Receivables filtered to that GC. The concentration line is a shortcut into the chase list, not a fact to read and move past." },
            { label: "Won, not invoiced", kind: "link", does: "Work that is won and finished with no invoice raised against it — the fastest cash in the building. Opens the list of jobs." },
            { label: "Cash in · last 6 months", does: "Payments RECEIVED per month, not invoices raised. The two move differently and this is the one the bank agrees with." },
            { label: "Days to pay", does: "How long money takes to arrive, weighted by amount — so one huge slow invoice counts more than five small quick ones." },
            { label: "Collection rate", does: "Collected ÷ billed for the period. Over 100% is not an error: it means older invoices landed inside the window." },
            { label: "Biggest outstanding", does: "The largest open items with what each one is — an AIA application, an invoice, or won work never billed." },
            { label: "See all", kind: "link", does: "Every block has one. It opens the tab that holds that block's full detail." },
            { label: "What the work cost", does: "Margin, total cost, the cost mix, and vendor spend for the year. The cost side of the same money." },
          ],
          watchOut:
            "Unpriced labor is hours logged against jobs with no rate on them yet. Those hours are real but cost nothing here, so margin reads HIGHER than it is until they are priced. Check that figure before quoting the margin to anyone.",
        },
        {
          name: "Receivables",
          href: "/commercial/accounting?view=receivables",
          path: "Accounting › Receivables",
          tourTarget: "accounting:record-payment",
          purpose:
            "Every job with money still out, and the form for recording a payment when it comes in. Each row carries a note so anyone can see what has been chased and when.",
          strip: { boxes: ACCOUNTING_BAR, at: accountingTabIndex("Receivables") },
          steps: [
            "Click Accounting in the left menu.",
            "Click the Receivables tab.",
            "The form Record a payment is at the top.",
            "Click Invoice. Type the GC or job name, then pick it.",
            "Type the Amount.",
            "Check Date received — it says today already.",
            "Pick the Method.",
            "Type the check or wire number in Reference.",
            "Click Record payment.",
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
          strip: { boxes: ACCOUNTING_BAR, at: accountingTabIndex("Purchases") },
          steps: [
            "Click Accounting in the left menu.",
            "Click the Purchases tab.",
            "The form Record a purchase is at the top.",
            "Click Job. Type the job name, then pick it from the list.",
            "Click Vendor. Pick the supplier, or type a new name.",
            "Type the Amount, and check the Date.",
            "Pick the Category.",
            "Type the receipt number in Reference.",
            "Click Receipt and choose the photo. On a phone this opens the camera.",
            "Click Record purchase.",
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
          strip: { boxes: ACCOUNTING_BAR, at: accountingTabIndex("Labor payments") },
          steps: [
            "Click Accounting in the left menu.",
            "Click the Labor payments tab.",
            "The form Record a labor payment is at the top.",
            "Click Job and pick the job.",
            "Click Paid to and pick the crew company.",
            "Type the Amount, and check Date paid.",
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
          steps: [
            "Click Accounting in the left menu.",
            "Click the Deposits tab.",
            "Read down the list against your bank statement.",
            "Click Mark on a row once it has cleared the bank. It turns green and reads Deposited.",
          ],
          strip: { boxes: ACCOUNTING_BAR, at: accountingTabIndex("Deposits") },
          watchOut:
            "Receivables and Deposits are the two halves of the same money: Receivables is what has not arrived, Deposits is what has. A payment moves from one to the other the moment you record it.",
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
          steps: [
            "Click Accounting in the left menu.",
            "Click the AR sheet tab.",
            "Read the lines — they build themselves from the AIA applications.",
            "To change one: click Edit the sheet, change it, click Save.",
            "To add one: click Edit the sheet, fill in Job and Billed / open, click Add line.",
            "Click Export for the file to send Alex.",
          ],
          strip: { boxes: ACCOUNTING_BAR, at: accountingTabIndex("AR sheet") },
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
            "Open the tab you want to send.",
            "Click Print / PDF at the top right.",
            "In the print box, set Destination to Save as PDF.",
            "Click Save.",
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
          steps: [
            "Click Accounting in the left menu.",
            "Click More, then AR aging.",
            "Read across: each GC's money by how late it is.",
          ],
          tourTarget: "accounting:aging",
          purpose: "What is owed by how late it is — 30, 60, 90 days and beyond, per GC. The answer to “how bad is it”.",
        },
        {
          name: "Cash flow",
          href: "/commercial/accounting?view=cash",
          path: "Accounting › More › Cash flow",
          steps: [
            "Click Accounting in the left menu.",
            "Click More, then Cash flow.",
            "Read the chart for money in by month, and the table for who pays slowest.",
          ],
          tourTarget: "accounting:cash",
          purpose: "Collected against billed by month, and how long each GC actually takes to pay.",
        },
        {
          name: "Job costs",
          href: "/commercial/accounting?view=costs",
          path: "Accounting › More › Job costs",
          steps: [
            "Click Accounting in the left menu.",
            "Click More, then Job costs.",
            "Click any job name to open its costs and add more.",
          ],
          tourTarget: "accounting:costs",
          purpose: "What each job has cost and what is left on it. Clicking a job opens its costs tool.",
        },
        {
          name: "Sales tax",
          href: "/commercial/accounting?view=tax",
          path: "Accounting › More › Sales tax",
          steps: [
            "Click Accounting in the left menu.",
            "Click More, then Sales tax.",
            "Set Issued to the period you are filing.",
            "Click Export for filing.",
          ],
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
          steps: [
            "Click Accounting in the left menu.",
            "Click More, then Transactions.",
            "Find the payment in its month.",
            "Click Mark when it has cleared the bank.",
          ],
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
          steps: [
            "Click Accounting in the left menu.",
            "Click More, then Balance owed.",
            "Click a job name to open its invoices.",
          ],
          tourTarget: "accounting:owed",
          purpose:
            "Jobs that are finished or on hold with money still out — Tomco's own Balance Owed report, the same records to the cent.",
        },
        {
          name: "Reimbursements",
          href: "/commercial/accounting?view=reimbursements",
          path: "Accounting › More › Reimbursements",
          steps: [
            "Click Accounting in the left menu.",
            "Click More, then Reimbursements.",
            "Find the person under Still owed.",
            "Click Mark paid once you have paid them back.",
          ],
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
