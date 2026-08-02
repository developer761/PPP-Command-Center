# Commercial Command Center — Remaining Build Plan (start → finish)

_Rewritten 2026-08 after reconciling the UX walks against the ORIGINAL master plan ([[commercial-master-plan-2026-07-24]]) + Katie's remaining notes ([[project_katie_notes_remaining_2026_08]]) + the scheduling spec ([[project_tomco_scheduling_spec_2026_08]]). The earlier draft was built from the UX walks only and under-counted the feature backlog — this is the corrected, comprehensive list to FULLY finish the platform._

---

## ✅ Already shipped (do NOT rebuild — verified in code)
Accounts (+ A/B/C rating) · Opportunities pipeline · Proposals + Builder + PDF · Documents (per-tool + deal filing cabinet) · **Change Orders** (incl. CO-as-invoice-line "incl. change order" tick model) · **AIA G702/G703** + Excel export · Submittals · **Closeout** (Letter of Transmittal + Warranty generators, tap-to-sign) · Invoicing + AR statement · Costs & Job P&L · Revenue analytics/charts · Dashboards · **Notifications** (inbox both platforms + custom rules + email opt-in + daily cron) · Estimator role + RBAC · Operating-company identity + brand + tap-to-sign · 2 full correctness-audit rounds + 2 UX-polish rounds.

Legend: **[BUILD]** = new feature · **[VERIFY]** = likely done, confirm/finish · **[FIX]** = small correction · **[PARKED]** = do opportunistically · **[CLEANUP]** = tech-debt.

## How every phase is built (Karan's standing bar — applies to ALL phases below)
- **Edge-cased properly + precisely** — a parallel adversarial edge-case agent runs BEFORE and AFTER every batch and after every push; every finding fixed, nothing deferred. Extreme/empty/null/concurrent/timezone/overflow states all handled.
- **Clear + concise UI/UX** — mini-KPIs + progress bars lead each surface; no gray boxes; dividers separate blocks; progressive disclosure (don't clutter); aggressive autofill; one-click / tap-to-sign; mobile-perfect 44px; searchable dropdowns >10 items; "can this be simpler?" on every screen.
- **Verified green** — tsc + tests + build before every push; single source of truth per opportunity; every action reflects everywhere it should (opp ↔ account ↔ global) instantly.

---

## Phase R1 — Proposal & estimating completion (Kim the estimator)
_Client-facing bits are used by anyone building a proposal (no role-gating); Kim is just the primary user._
- **[BUILD]** Per-line **"show price" checkbox** — checked prints the line total on the client PDF, unchecked hides it. _Edge: all-hidden proposal still shows a total; toggling recomputes the printed subtotal; hidden lines still count toward the total._
- **[BUILD]** **Adjustable final price** (override the summed total) on the client proposal. _Edge: override < 0 rejected; override vs line-sum delta shown internally; clears cleanly back to auto; flows to the contract/AIA base + invoicing consistently._
- **[BUILD]** **Bid Set date** field, shown on the proposal.
- **[BUILD]** **Internal bid notes** (never on the client PDF) + **attach Kim's marked-up plan/spec doc** to the internal side. _Edge: large plan uploads (see R6 chunked upload); internal-only never leaks to the client render._
- **[BUILD]** **Approval loop** (Resend): Kim clicks **"Get approval"** → emails Brendan → he approves/rejects → returns to Kim as approved/rejected, audit-logged. _Edge: re-request after edit; approve/reject race; Brendan email missing; status reflected on the proposal + pipeline._

## Phase R2 — Document generators & doc fidelity
- **[BUILD]** **Work Order for the crew** — header (date/project/location/subject) + Inclusions / Add-Alternate / Exclusions bullets + **Room Finish Schedule** table (mirrors Tomco's Panera format; reuses proposal + finish-schedule data).
- **[FIX]** AIA `contractorLabel` hardcoded "Precision Painting Plus" → drive from the **operating company (Tomco)**; verify the Excel export matches Tomco's blank G702/G703 template.
- **[VERIFY]** Closeout **Letter of Transmittal must exclude COI**; Warranty defaults to **12 months** ("Form of Warranty", Brendan Dwyer VP block) with tap-to-sign.

## Phase R3 — Search & navigation
- **[BUILD]** **Universal Search** — one interactive topbar bar to find any account / opportunity / **invoice** (by #/PO/amount) / proposal / document, with **entity filter chips** + **account scoping** ("invoices for Turner", "overdue invoices"). Extends the ⌘K palette; subsumes a standalone document-search page. ~5–7h.
- **[BUILD]** **Job "What's Due" strip** on an opportunity's Overview — COs pending, AIA ready to submit, submittals aging (days waiting), overdue invoices ($), unreleased retainage. ~3–4h.
- **[BUILD]** **Navigation restructure** — one home per production tool (kills the save-ejects-you-to-a-different-surface bug), collapse the P&L surfaces into one "Costs & P&L" tab, flatten the deal's 3–4 tab levels, unify "open an opportunity" to the canonical drill-in.

## Phase R4 — Reports (K)
- **[BUILD]** Reusable **Reports framework** — each report a tab; starter set **Pipeline · Sales · AR aging**; include **Kim's Plan Report**; "export = the filtered set."
- **[BUILD]** **AR export / statement (CSV/print)** — aging-by-customer for collections calls (was parked → folds here).

## Phase R5 — Project rollups & billing completeness
- **[VERIFY/FINISH]** Project rollups: total hours worked · payments received · balance owed (project amount − payments, across multiple invoices) · purchases · labor payments out — surfaced on the project header.
- **[BUILD]** **Billing signpost** — cross-link Invoices ↔ AIA so a PM knows on day one how a GC gets billed.

## Phase R6 — Intake & uploads
- **[BUILD]** **Chunked PDF upload** (TUS resumable via Supabase Storage) — plans/specs run 20–100 MB and currently time out; add a progress bar + resume-on-disconnect.
- **[BUILD]** **Online public bid form** `/c/bid-submit` (no-auth, Turnstile/hCaptcha) → lands as a new opportunity in `inquiry` + creates the account if new + bells the owner.
- **[PARKED]** Archive project docs to **Google Drive / Dropbox** + restore.

## Phase R7 — Onboarding & pipeline speed
- **[BUILD]** **Getting-started checklist** on the dashboard (Add GC → opportunity → proposal → Won → invoice), lights up as data appears, auto-hides once active.
- **[BUILD]** **Field-ops purchase/hours form redesign** — photo-first (receipt tile on top), "My jobs today", big Log-hours/Snap-receipt, worker auto-filled to the logged-in user, date = today.
- **[BUILD]** **Faster pipeline actions** — inline "create new GC" in the pickers (partly shipped as links), proposal-builder entry on the opportunity detail, one-click stage-advance (auto-submit + undo toast), "Move to…" filtered to legal next stages everywhere.
- **[BUILD]** Account header **open-opportunity count + balance**; **alphabetical-by-customer sort** on the pipeline.

## Phase R8 — Hardening
- **[BUILD]** **Accessibility** — focus-trap/inert wrapper for the 3 slide-out sheets; finish the `charcoal-400 → 500` contrast sweep beyond the dashboard; remaining focus-visible rings.
- **[BUILD]** **Security** — DOMPurify-grade email-HTML sanitizer before any archived email is ever customer-facing; route the remaining raw date formatters through `fmtEtDate`.
- **[BUILD]** **View-only access role** — least-privilege commercial login (today any login can void invoices + see every P&L). Pairs with the scheduler-role work in R10.
- **[CLEANUP]** Remove orphan `TeamTab`/`NotesTab`; consolidate the near-duplicate tile components (`SummaryTile`/`AiaSummaryTile`/`CloseoutStat`/`ProjectStat`/`SubmittalStat`) into one shared tile; grouped-invoice sort + stray `new Date(field)` formatters through the null-safe path.

## Phase R9 — Dark mode finish (over completed surfaces)
- **[FINISH]** Dark-mode **foundation already shipped**; finish the contrast pass + navy accent across every page now that surfaces are stable.

## Phase R10 — Field Ops / Scheduling  🐘 (the giant — build LAST)
- **[BUILD]** Full spec in [[project_tomco_scheduling_spec_2026_08]]: data model + **6 views** (Week Grid, Calendar, Job Board, mobile Daily Log, Approvals, Admin) + time-entry state machine (draft→submitted→approved→locked) + **payroll CSV** + per-job phases + receipts/labor-out/clock-in-out. **The `scheduler` role lands here.** Multi-day — realistically half the remaining effort on its own.

---

## ★ Endgame (do NOT declare the platform done before these)
1. **[BONUS]** **Parse RFP email → auto-populate the Opportunity** (sender→account, subject→title, body→notes, attachments→docs) — the "Future State" force-multiplier.
2. **[FINAL] Full platform audit** — money/KPIs, backend/security, UI/UX + flow, mobile, accessibility (the same multi-agent adversarial pass we've been running), fix every finding.
3. **[FINAL] Start-to-finish smoke-test script** — a written click-through covering the whole lifecycle: new GC → opportunity → proposal → approval → Won → project → change order → AIA app → submittal → invoice → payment → lien waiver → closeout (LoT + warranty) → reports, on desktop AND mobile, with expected result at each step.
4. **[FINAL] Joint walkthrough with Karan** — do the smoke test together; only then is the platform "done."

## ★★ Final bonus phase — Spanish / i18n
Per Karan: **last, after everything above is built + operational.** Login + the field forms first, then a full locale pass + a UI language toggle carried through the field surfaces.
