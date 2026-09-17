import type { RoleGuide } from "./walkthrough";

/**
 * Brendan and Stephanie — the two people whose day is a job rather than a
 * ledger.
 *
 * They are in their own file because Mary's chapters follow the Accounting
 * tabs and these follow the job page; the two halves get edited at different
 * times by different people.
 *
 * WHERE THE SPLIT IS. Brendan sells the work and gets it delivered — the bid,
 * the proposal, the crew, the schedule. Stephanie runs the paperwork that keeps
 * a live job legal and billable — submittals, change orders, AIA applications,
 * closeout. They meet on the job page, on different tools of it.
 *
 * EVERY LABEL HERE IS QUOTED FROM THE COMPONENT THAT RENDERS IT. The first
 * draft of this file was written from memory and got the job page's own tabs
 * wrong — it invented an "Info" tab and a top-level "Invoices" tab, and called
 * Documents "Docs". A walkthrough that names tabs which are not on screen is
 * worse than no walkthrough, because the reader concludes they are on the wrong
 * page. If a label changes, change it here.
 */

/**
 * The job page's primary tabs, in order.
 *
 * Project, Analytics and Debrief are conditional — Project and Analytics appear
 * once a deal is won or in delivery, Debrief once it is decided — so a job
 * still out for bid shows the first five only.
 */
const JOB_TABS = ["Overview", "Where it stands", "Proposals", "Documents", "Activity", "Project"];

/**
 * The delivery tools as they are LABELLED ON THE TILES you click.
 *
 * Two of them read differently once open: the Costs tile opens a tool headed
 * "Transactions & Job P&L", and Closeout & Warranty opens one headed
 * "Closeout". Worth knowing, because somebody following a written instruction
 * that says "Transactions" will be looking for a tile that says Costs.
 */
const PROJECT_TILES = [
  "Submittals",
  "Work Order",
  "Change Orders",
  "Costs",
  "AIA Billing",
  "Invoices",
  "Closeout & Warranty",
];

export const BRENDAN: RoleGuide = {
  key: "brendan",
  label: "Brendan",
  tagline: "Bids and getting it built",
  intro:
    "Your day is the job list: what is out for bid, what came back, and what is on site this week. Almost everything happens on a job's own page — open it once and work down its tabs.",
  chapters: [
    {
      id: "brendan-sell",
      title: "Winning the work",
      blurb: "A GC asks for a price, you price it, they say yes or no.",
      surfaces: [
        {
          name: "Opportunities",
          href: "/commercial/opportunities",
          path: "Opportunities",
          purpose:
            "Every job and bid in one list, with saved views for the way you want to read it — proposals out, active jobs, billing. This is where a new job starts and where you come back to find one.",
          watchOut:
            "There is no bid low/high on the job form any more. A job's price lives on its proposal, which is the third tab along.",
        },
        {
          name: "The job page",
          href: "/commercial/opportunities/:wonjob",
          path: "Opportunities › any job",
          purpose:
            "Everything about one job, across its tabs. Project and Analytics only appear once the job is won or in delivery, and Debrief appears once it has been decided — so a job still out for bid shows fewer tabs than one on site.",
          strip: { boxes: JOB_TABS, at: 0 },
          controls: [
            { label: "Overview", tourTarget: "job:tab:overview", does: "The summary, with Info and Team underneath it." },
            { label: "Where it stands", tourTarget: "job:tab:standing", does: "The stage the job is at, and what moves it on." },
            { label: "Proposals", tourTarget: "job:tab:proposals", does: "The price and the document that goes to the GC." },
            { label: "Documents", tourTarget: "job:tab:docs", does: "Plans & Specs, Colors & Finishes, and Files." },
            { label: "Activity", tourTarget: "job:tab:activity", does: "Notes, Tasks, Timeline and the Email Archive." },
            { label: "Project", tourTarget: "job:tab:project", does: "The delivery tools. Only once the job is won." },
          ],
        },
        {
          name: "Proposals",
          href: "/commercial/opportunities/:job?tab=proposals",
          path: "The job › Proposals",
          tourTarget: "job:tab:proposals",
          purpose:
            "Where the job is priced and the proposal is built. A proposal cannot go straight from draft to the GC — it is approved internally first, on purpose.",
          strip: { boxes: JOB_TABS, at: 2 },
          steps: [
            "Press New proposal in the Proposals card and build it — scope, exclusions, tax.",
            "Press Send for approval. It goes to an approver, not the GC.",
            "The approver presses Approve, or Request changes and sends it back.",
            "Once approved, press Send proposal, then Send to GC in the window that opens.",
            "When the GC answers, press Mark won or Mark lost.",
          ],
          controls: [
            { label: "New proposal", does: "Starts one. Revisions come later and are numbered R2, R3 and so on." },
            { label: "Send for approval", does: "Puts it in front of an approver. It does NOT reach the GC." },
            { label: "Withdraw", does: "Pulls it back out of approval before anybody has answered." },
            { label: "Approve", does: "Approver only. Unlocks the proposal so it can be sent out." },
            { label: "Send back for changes", does: "Approver only, inside Request changes — returns it with a note saying what needs to change." },
            { label: "Send proposal", does: "Opens the send window. Reads Email again once it has already gone." },
            { label: "Send to GC", does: "The primary button in that window. Actually emails it." },
            { label: "Just mark as sent", does: "For a proposal you sent yourself, outside the platform. Records it without emailing." },
            { label: "Unlock to edit", does: "Reopens an approved proposal for changes. It will need approving again." },
            { label: "Mark won", does: "Records the win and flips the job to Won." },
            { label: "Mark lost", does: "Records the loss and takes you to the debrief." },
          ],
          watchOut:
            "Send for approval and Send proposal are two different buttons doing two different things. The first goes to an approver; only the second reaches the GC.",
        },
        {
          name: "Change status",
          href: "/commercial/opportunities/:job?tab=standing",
          path: "The job › Where it stands",
          tourTarget: "job:tab:standing",
          purpose:
            "Moving a job along. Most moves happen by themselves as you do the work, so this card is for what the platform cannot see — a verbal yes, or a no-bid.",
          strip: { boxes: JOB_TABS, at: 1 },
          controls: [
            { label: "Move this deal to", kind: "field", does: "The stage to move to. Only sensible next stages are offered." },
            { label: "Save", does: "Applies the move." },
            { label: "Debrief later", does: "On a Won or Lost move — records it now and leaves the debrief for later." },
            { label: "Mark won or lost", does: "The quick flip on the status bar. Two options, one click each." },
            { label: "Start the job", does: "Quick flip: moves a won job into Pre-Construction." },
            { label: "Put it in progress", does: "Quick flip: moves it to In Progress, on site." },
            { label: "Mark it completed", does: "Quick flip: moves it to Completed." },
          ],
          watchOut:
            "Record the win the day the GC says yes, even if the paperwork lands next week. A late win date makes every report wrong, and the platform will not stop you — it warns rather than blocks, on purpose.",
        },
      ],
    },
    {
      id: "brendan-build",
      title: "Getting it built",
      blurb: "Won work becomes a work order, a crew and a set of hours.",
      surfaces: [
        {
          name: "Work Order",
          href: "/commercial/opportunities/:wonjob?tab=project&sub=work-order",
          path: "The job › Project › Work Order",
          tourTarget: "job:tool-open:work-order",
          purpose:
            "The sheet the crew works from. Its scope is seeded from the accepted proposal and the finish schedule, so you are editing rather than typing it out.",
          strip: { boxes: PROJECT_TILES, at: 1 },
          controls: [
            { label: "+ Create work order", does: "Makes the first sheet for this job." },
            { label: "+ Add another work order", does: "A second sheet, for splitting scope across crews." },
            { label: "Assigned crew / foreman", kind: "field", does: "Who is doing it." },
            { label: "Scope on this sheet", kind: "field", does: "Tick the scope lines that belong on this sheet." },
            { label: "Preview PDF", does: "The draft as the crew will see it. Reads View sent PDF once sent, and serves the frozen copy." },
            { label: "Send to Field Ops", does: "Releases it to the field. This is the point the crew can see it." },
            { label: "Re-open to edit", does: "Pulls a sent sheet back into draft." },
            { label: "Void", does: "Kills the sheet without deleting the record." },
          ],
        },
        {
          name: "Calendar",
          href: "/commercial/field-ops/calendar",
          path: "Field Ops › Calendar",
          purpose:
            "Who is on which job, by week. Put a crew on a day here and they get their schedule by email — in Spanish where that is their language.",
        },
        {
          name: "Approvals",
          href: "/commercial/field-ops/approvals",
          path: "Field Ops › Approvals",
          purpose: "Hours the foremen submitted, waiting on you — approve them, or question one and send it back.",
          watchOut:
            "Hours are a record of who was on site. They are not what the crew is paid: that is a labor payment Mary records on the Accounting page. The two are kept apart so a job is never charged twice.",
        },
        {
          name: "Crew",
          href: "/commercial/field-ops/employees",
          path: "Field Ops › Crew",
          purpose: "Adding a crew member, setting a cost rate, and giving somebody a clock-in PIN.",
        },
      ],
    },
    {
      id: "brendan-watch",
      title: "Keeping an eye on it",
      blurb: "The reports you run rather than build.",
      surfaces: [
        {
          name: "Pipeline",
          href: "/commercial/reports/pipeline",
          path: "Reports › Pipeline",
          purpose: "Every open bid, what it is quoted at, and who to ring about it.",
        },
        {
          name: "Scheduling",
          href: "/commercial/reports/scheduling",
          path: "Reports › Scheduling",
          purpose: "Jobs in coordination, on site or on hold, and what each still owes.",
        },
        {
          name: "Win / Loss",
          href: "/commercial/reports/win-loss",
          path: "Reports › Win / Loss",
          purpose:
            "Every deal decided in a period — what it was worth, who we were up against, and why the ones we lost went the other way. Group it by outcome, by GC, or by why we lost.",
          watchOut: "It is only as good as the debriefs. A win with no reason recorded still counts, but it tells nobody anything.",
        },
        {
          name: "Attendance",
          href: "/commercial/reports/attendance",
          path: "Reports › Attendance",
          purpose: "Who was on site, on which job, for how long. Hours, not cost.",
        },
      ],
    },
  ],
};

export const STEPHANIE: RoleGuide = {
  key: "stephanie",
  label: "Stephanie",
  tagline: "Job paperwork",
  intro:
    "Your work is the paperwork that keeps a live job legal and billable — submittals up front, change orders as the scope moves, AIA applications every month, and the closeout at the end. All four are tiles on a job's Project tab.",
  chapters: [
    {
      id: "steph-tools",
      title: "The Project tab",
      blurb:
        "Open a job and press Project. You get a set of tiles; pressing one opens that tool on its own, with a back arrow to the list. Two tiles are named differently from the tool they open — Costs opens Transactions, and Closeout & Warranty opens Closeout.",
      surfaces: [
        {
          name: "Submittals",
          href: "/commercial/opportunities/:wonjob?tab=project&sub=submittals",
          path: "The job › Project › Submittals",
          tourTarget: "job:tool-open:submittals",
          purpose:
            "The product data the GC needs before work starts, put together as a package with a Letter of Transmittal. Packages are numbered SUB-001, SUB-002 and so on.",
          strip: { boxes: PROJECT_TILES, at: 0 },
          steps: [
            "Press + New submittal. It creates a draft and takes you straight into it.",
            "Add the items and attach the files.",
            "Press Download PDF and send the Letter of Transmittal to the GC yourself.",
            "Press Mark as sent to GC to record that it has gone.",
            "When they answer, press Mark received by GC, then record their answer.",
          ],
          controls: [
            { label: "+ New submittal", does: "Creates a draft Letter of Transmittal and opens it." },
            { label: "Add item", does: "Adds a line to the package." },
            { label: "Attach selected", does: "Links files on the job to the item." },
            { label: "Download PDF", does: "The Letter of Transmittal, to send on yourself." },
            { label: "Mark as sent to GC", does: "Records that it has gone. It does NOT email the GC — you send the PDF." },
            { label: "Mark received by GC", does: "Moves it from Submitted to Under Review." },
            { label: "Record approved as submitted", does: "Their answer, recorded. There are four: approved as submitted, approved as noted, revise & resubmit, rejected." },
            { label: "+ Create revision", does: "After a revise or reject — starts the next round, numbered Rev 2." },
            { label: "Close submittal", does: "Ends it once approved." },
            { label: "Void submittal", does: "Kills one raised in error." },
          ],
          watchOut:
            "Mark as sent to GC does not email anybody. It records that you sent it. Download the PDF and send it yourself first, or the GC is waiting on something that never arrived.",
        },
        {
          name: "Change Orders",
          href: "/commercial/opportunities/:wonjob?tab=project&sub=change-orders",
          path: "The job › Project › Change Orders",
          tourTarget: "job:tool-open:change-orders",
          purpose:
            "Extra work, priced and put in writing. Raised, sent to the GC for their answer, then recorded — and only then does it count toward the contract.",
          strip: { boxes: PROJECT_TILES, at: 2 },
          steps: [
            "Open Add a change order, fill in the title, direction and amount, and press Add change order.",
            "Open Send for approval, check the message, and press Send to GC.",
            "When they answer, press Approve or Decline.",
            "Once approved, press Add to invoice to bill it.",
          ],
          controls: [
            { label: "Add a change order", does: "Opens the form. Inside it, Add change order saves." },
            { label: "Add / Deduct", kind: "field", does: "Whether this adds to the contract or credits the GC." },
            { label: "Send for approval", does: "Opens the send form. Reads Send again once it has been sent before." },
            { label: "Send to GC", does: "Emails it. Sending does NOT approve it." },
            { label: "Approve", does: "Records the GC's yes. This is what adds it to the contract." },
            { label: "Decline", does: "Records their no. Reopen & approve if they change their mind." },
            { label: "Add to invoice", does: "Bills an approved change order. Reads Add credit on a deduct." },
            { label: "All change orders (PDF)", does: "One PDF listing every change order and the updated contract total." },
          ],
          watchOut:
            "Sending is not approving. A change order stays pending until the GC answers, and an unapproved one is not money — it is not in the contract and cannot be billed.",
        },
        {
          name: "AIA Billing",
          href: "/commercial/opportunities/:wonjob?tab=project&sub=aia",
          path: "The job › Project › AIA Billing",
          tourTarget: "job:tool-open:aia",
          purpose:
            "The G702/G703 payment applications. Each one carries the percentages forward from the last, so you are only entering what changed this month.",
          strip: { boxes: PROJECT_TILES, at: 4 },
          steps: [
            "Open New application, set Period to and the retainage percentage, and press Create application.",
            "Fill in this month's figures on the continuation lines.",
            "Under Mark as, press Submitted once it has gone to the GC.",
            "At the end of the job, press Bill the retainage to raise the final application.",
          ],
          controls: [
            { label: "New application", does: "Opens the form for the next one." },
            { label: "Period to", kind: "field", does: "The end of the billing period this application covers." },
            { label: "Retainage (%)", kind: "field", does: "What the GC holds back on this application." },
            { label: "Add line", does: "Another line on the G703 continuation sheet." },
            { label: "Mark as", does: "Three buttons — Draft, Submitted, Paid — for where the application has got to." },
            { label: "Export to Excel", does: "The application as a spreadsheet, which is how it reaches the GC." },
            { label: "Bill the retainage", does: "Raises the Application for Final Payment, releasing what has been held." },
          ],
          watchOut:
            "Marking an application Paid records no money. Payments are recorded against invoices, by Mary, on the Accounting page. An AIA job raises no invoice, so it will not show on any list that counts invoices — it reaches Mary's AR sheet by itself once issued.",
        },
        {
          name: "Closeout & Warranty",
          href: "/commercial/opportunities/:wonjob?tab=project&sub=closeout",
          path: "The job › Project › Closeout & Warranty",
          tourTarget: "job:tool-open:closeout",
          purpose:
            "The pack the GC needs at the end, as a checklist that tells you what is still missing — and the warranty letter, which runs twelve months from substantial completion.",
          strip: { boxes: PROJECT_TILES, at: 6 },
          controls: [
            { label: "+ New close-out package", does: "Creates one, seeded with the standard checklist and the one-year warranty." },
            { label: "+ Add item", does: "Another line on the checklist." },
            { label: "Transmittal cover + warranty", kind: "field", does: "The cover details — who it goes to, the subject, substantial completion, remarks. It saves as you type." },
            { label: "Transmittal PDF", does: "The cover sheet to send with the pack." },
            { label: "Warranty letter PDF", does: "The warranty on its own." },
            { label: "Issue warranty letter", does: "Issues it and starts the clock. Reads Issue again afterwards." },
            { label: "Mark sent", does: "Records that the pack has gone. Then Mark acknowledged, then Mark complete." },
          ],
          watchOut:
            "Retention is released at close-out. Until a job is closed out, that money is not late and Mary should not be chasing it as overdue.",
        },
        {
          name: "Costs",
          href: "/commercial/opportunities/:wonjob?tab=project&sub=transactions",
          path: "The job › Project › Costs",
          tourTarget: "job:tool-open:transactions",
          purpose:
            "Everything spent on the job and what it has made — the tool is headed “Transactions & Job P&L” once you open it. Entries are numbered TRANS-0001 and up.",
          strip: { boxes: PROJECT_TILES, at: 3 },
          controls: [
            { label: "Log a transaction", does: "Opens the form. Inside it, Add transaction saves." },
            { label: "Edit", does: "Changes one you already recorded." },
            { label: "Receipt", does: "Downloads the receipt where one was attached." },
          ],
          watchOut:
            "This is the same money Mary sees on Accounting › Purchases. Record it in one place or the other, not both.",
        },
      ],
    },
    {
      id: "steph-docs",
      title: "Paperwork and history",
      blurb: "Where things end up once they have been sent.",
      surfaces: [
        {
          name: "Documents",
          href: "/commercial/opportunities/:job?tab=docs",
          path: "The job › Documents",
          tourTarget: "job:tab:docs",
          purpose:
            "Everything filed against the job, in three places: Plans & Specs, Colors & Finishes, and Files.",
          strip: { boxes: JOB_TABS, at: 3 },
        },
        {
          name: "Activity",
          href: "/commercial/opportunities/:job?tab=activity",
          path: "The job › Activity",
          tourTarget: "job:tab:activity",
          purpose:
            "The history of the job — Notes, Tasks, Timeline, and the Email Archive of everything sent and received about it.",
          strip: { boxes: JOB_TABS, at: 4 },
        },
        {
          name: "Email",
          href: "/commercial/email",
          path: "Email",
          purpose:
            "Everything sent to and received from a GC, across every job, in one place. The fastest way to check whether somebody actually replied.",
        },
      ],
    },
  ],
};
