# Commercial Command Center — Build Checklist (start → finish)

_**LIVING CHECKLIST.** Every item is checked off the moment it ships; the full checklist (done + remaining) is relayed to Karan after each completion. Same checklist format for the end-stage edge-case + smoke-test sweeps. Reconciled against the master plan + Katie's notes + the scheduling spec — this is the true finish line._

## How every phase is built (standing bar — every phase)
- [ ] **Think like Karan FIRST — build it right the first time.** Anticipate what "done" looks like to him AND what he'd send back, then build THAT from the start. Single source of truth per opportunity; every action reflects everywhere instantly (opp ↔ account ↔ global); mini-KPIs + progress bars lead; aggressive autofill + tap-to-sign; docs match Tomco formats; never hard-reject money (cap/allow/credit + small heads-up); simplest robust version; no gray boxes; mobile-perfect. Proactively propose the dual-surface pattern (sidebar queue + opportunity home + account rollup) on every tool.
- [ ] **Edge-case + bug-test EVERYTHING, before AND after every phase** — parallel adversarial agent on UI edges (extreme/empty/null/concurrent/timezone/overflow) AND flow/logic end-to-end. Fix all, defer none.
- [ ] **Verified green** — tsc + tests + build before every push.

---

## ✅ Shipped foundation (Phases 0–2 + G + H + audits/UX)
- [x] Accounts (+ A/B/C rating)
- [x] Opportunities pipeline
- [x] Proposals + Builder + PDF
- [x] Documents (per-tool + deal filing cabinet)
- [x] Change Orders (incl. CO-as-invoice-line "incl. change order")
- [x] AIA G702/G703 + Excel export
- [x] Submittals & finish schedule
- [x] Closeout (Letter of Transmittal + Warranty generators + tap-to-sign)
- [x] Invoicing + open-invoice AR statement
- [x] Costs & Job P&L
- [x] Revenue analytics / charts
- [x] Dashboards
- [x] Notifications (inbox both platforms + custom rules + email opt-in + daily cron)
- [x] Estimator role + RBAC + operating-company identity + brand + tap-to-sign
- [x] 2 correctness-audit rounds + 2 UX-polish rounds

---

## ⬜ Phase R1 — Proposal & estimating (Kim; client-facing bits used by anyone)
- [ ] Per-line **"show price" checkbox** (client PDF prints/hides the line total)
- [ ] **Adjustable final price** (override the summed total)
- [ ] **Bid Set date** on the proposal
- [ ] **Internal bid notes** (never on client PDF) + **attach Kim's marked-up plan/spec doc**
- [ ] **Approval loop — IN-APP, HARD GATE** (Karan 2026-08): Kim (or anyone) clicks **"Send for approval"** → status `Pending approval`; **a proposal CANNOT be sent to the client until approved.** Approvers = **any admin (incl. Karan)** PLUS an **editable approver list** (default **Brendan + Stephanie**, matched by login email) — **server-enforced**. Only approvers see & can click **Approve / Request changes** (with note); everyone else can do everything else, just not the Approve button or send-unapproved. Audit-logged. **Notifications (reuse existing system):** send-for-approval → bell + email to the approvers; approved/changes-requested → bell + email back to the sender. Approver designation coordinates with the R8 role work.
- [ ] Edge-case + flow/logic bug-test (before + after) · tsc/tests/build green · pushed

## ⬜ Phase R2 — Document generators & doc fidelity
- [ ] **Work Order for the crew** — tool card on the opportunity's Project tab; autofills Inclusions/Alternates/Exclusions from the proposal + Room Finish Schedule from finish-schedule data; Generate → Tomco-letterhead PDF + tap-to-sign → files to deal Documents → rolls up to account
- [ ] **Work Orders sidebar index** (Post-Contract group) — cross-account status queue (⚪ not created · 🟡 draft · 🟢 sent to crew), row → the opportunity's Work Order tool
- [ ] AIA `contractorLabel` → operating company (Tomco); verify Excel matches Tomco's blank template
- [ ] Verify closeout **LoT excludes COI** + Warranty defaults to **12 months** (Brendan Dwyer VP block) with tap-to-sign
- [ ] Edge-case + flow/logic bug-test (before + after) · tsc/tests/build green · pushed

## ⬜ Phase R3 — Search & navigation
- [ ] **Universal Search** — topbar bar for any account / opportunity / invoice (#/PO/amount) / proposal / document, with entity filter chips + account scoping ("invoices for Turner", "overdue")
- [ ] **Job "What's Due" strip** on the opportunity Overview (COs pending · AIA ready · submittals aging · overdue $ · unreleased retainage)
- [ ] **Navigation restructure** — one home per tool (kill the save-ejects bug), collapse P&L surfaces into one tab, flatten the deal's 3–4 tab levels, unify "open an opportunity"
- [ ] Edge-case + flow/logic bug-test (before + after) · tsc/tests/build green · pushed

## ⬜ Phase R4 — Reports
- [ ] Reusable **Reports framework** — each report a tab; starter Pipeline · Sales · AR aging; **Kim's Plan Report**; export = the filtered set
- [ ] **AR export / statement (CSV / print)** — aging-by-customer
- [ ] Edge-case + flow/logic bug-test (before + after) · tsc/tests/build green · pushed

## ⬜ Phase R5 — Project rollups & billing completeness
- [ ] Project rollups on the project header: total hours · payments received · balance owed (across multiple invoices) · purchases · labor payments out
- [ ] **Billing signpost** — cross-link Invoices ↔ AIA (how this GC gets billed)
- [ ] Edge-case + flow/logic bug-test (before + after) · tsc/tests/build green · pushed

## ⬜ Phase R6 — Intake & uploads
- [ ] **Chunked PDF upload** (TUS resumable; 20–100 MB plans/specs; progress bar + resume)
- [ ] **Online public bid form** `/c/bid-submit` (no-auth + Turnstile) → new opportunity + account-if-new + bell
- [ ] *(Parked)* Archive project docs to Google Drive / Dropbox + restore
- [ ] Edge-case + flow/logic bug-test (before + after) · tsc/tests/build green · pushed

## ⬜ Phase R7 — Onboarding & pipeline speed
- [ ] **Getting-started checklist** on the dashboard (lights up as data appears, auto-hides)
- [ ] **Field-ops purchase/hours form redesign** (photo-first, receipt on top, worker auto-filled, date=today)
- [ ] **Faster pipeline actions** — inline "create GC", proposal entry on opportunity, one-click stage-advance + undo, "Move to…" legal-only everywhere
- [ ] Account header open-opportunity count + balance · alphabetical-by-customer sort
- [ ] Edge-case + flow/logic bug-test (before + after) · tsc/tests/build green · pushed

## ⬜ Phase R8 — Hardening
- [ ] **Accessibility** — focus-trap/inert for the 3 slide-out sheets + finish contrast sweep + remaining focus rings
- [ ] **Security** — DOMPurify-grade email-HTML sanitizer; raw date formatters → `fmtEtDate`
- [ ] **View-only access role** (least-privilege commercial login)
- [ ] **Cleanups** — remove orphan TeamTab/NotesTab; consolidate duplicate tile components; latent date-safety
- [ ] Edge-case + flow/logic bug-test (before + after) · tsc/tests/build green · pushed

## ⬜ Phase R9 — Dark mode finish
- [ ] Contrast pass + navy accent across every page (foundation shipped; finish over stable surfaces)
- [ ] Edge-case + flow/logic bug-test (before + after) · tsc/tests/build green · pushed

## ⬜ Phase R10 — Field Ops / Scheduling  🐘 (the giant — LAST)
- [ ] Data model + per-job phases + **scheduler role**
- [ ] Week Grid view
- [ ] Calendar view
- [ ] Job Board view
- [ ] Mobile Daily Log view
- [ ] Approvals view
- [ ] Admin view
- [ ] Time-entry state machine (draft→submitted→approved→locked; questioned→foreman)
- [ ] Payroll CSV export
- [ ] Receipts + labor-out + clock-in/out (reconcile w/ residential receipts)
- [ ] Edge-case + flow/logic bug-test (before + after) · tsc/tests/build green · pushed

---

## ⬜ ★ ENDGAME — full platform audit (do NOT declare done until all checked)
- [ ] Money / KPI / backend audit — every finding fixed
- [ ] UI/UX + flow audit — every finding fixed
- [ ] Mobile audit — every finding fixed
- [ ] Accessibility audit — every finding fixed
- [ ] Security audit — every finding fixed

## ⬜ ★ ENDGAME — start-to-finish SMOKE TEST (desktop AND mobile, expected result each step)
- [ ] Add a new GC (account)
- [ ] Log a new opportunity under it
- [ ] Build a proposal (show/hide prices, adjustable total)
- [ ] Get approval (Kim → Brendan)
- [ ] Mark Won → auto-becomes a project
- [ ] Generate the crew Work Order
- [ ] Raise a change order → approve → bill onto an invoice
- [ ] Create an AIA application → G702/G703 → Excel export
- [ ] Send a submittal → Letter of Transmittal
- [ ] Create an invoice → send
- [ ] Record a payment → attach the lien waiver
- [ ] Close out (LoT + Warranty, tap-to-sign)
- [ ] Run the Reports + Universal Search
- [ ] Verify every step reflected on the account + dashboard + notifications
- [ ] **Joint walkthrough with Karan** — we do it together; only then is the platform DONE

## ⬜ ★★ BONUS (after platform is done + operational)
- [ ] Parse RFP email → auto-populate the Opportunity
- [ ] Spanish / i18n (login + field forms first, then full locale + toggle)
