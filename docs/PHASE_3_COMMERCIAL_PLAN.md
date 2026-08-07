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

## ✅ Phase R1 — Proposal & estimating (Kim; client-facing bits used by anyone)
- [x] Per-line **"show price" checkbox** (client PDF prints/hides the line total)
- [x] **Adjustable final price** (override the summed total) — flows into `total_cents` (the one contract number)
- [x] **Bid Set date** on the proposal
- [x] **Internal bid notes** (never on client PDF) + **attach Kim's marked-up plan/spec doc** (files to the deal's `bid_set` docs; survives revision bumps)
- [x] **Approval loop — IN-APP, HARD GATE** (Karan 2026-08): "Send for approval" → `Pending approval` → approver **Approve / Request-changes (with note)** → `Approved` → **Send** (draft can no longer send). Approvers = any admin PLUS a per-user **Approver** toggle on **Settings → Access** (admin-gated; writes `approver_emails`). **Server-enforced** in `db.ts` (`approveProposal`/`requestProposalChanges` reject non-approvers) AND the kanban outcome route routes drag-to-approve through the same gate. Bell + email on all three events. New `Approved` kanban column. Audit-logged via `updateProposalStatus`.
- [x] Edge-case + flow/logic bug-test (before + after) · tsc/tests/build green · pushed — *adversarial audit caught a CRITICAL deal-axis gate bypass (deal-drag → unapproved proposal 'sent'); fixed + re-verified. tsc + 141 tests + build GREEN. Pushed @ 7e13f8f.*

## 🔄 Phase R2 — Document generators & doc fidelity
- [x] **Work Order for the crew** — tool card on the Project tab (create / edit crew fields / preview / send-to-crew / re-open / void); autofills Inclusions/Alternates/Exclusions from the accepted proposal (fallback: latest) + Room Finish Schedule; Tomco-letterhead PDF + tap-to-sign → files to deal Documents (category `work_order`) → account rollup. Migration 106.
- [x] **Work Orders sidebar index** (Post-Contract) — cross-account status queue (not created · draft · sent to crew) + KPIs, row → the Work Order tool.
- [ ] AIA `contractorLabel` → operating company (Tomco); verify Excel matches Tomco's blank template
- [ ] Verify closeout **LoT excludes COI** + Warranty defaults to **12 months** (Brendan Dwyer VP block) with tap-to-sign
- [x] Edge-case + flow/logic bug-test (before + after) · tsc/tests/build green · pushed — *adversarial audit found the sent-WO-renders-live divergence + a same-status double-file; both fixed (snapshot pinned, DAG tightened) + 2 LOWs. tsc · 141 tests · build green. Pushed @ a5a9884.*

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

## 🔄 Phase R7 — Onboarding & pipeline speed
- [x] **Guided onboarding tour** (2026-08-04) — one-time, physically navigates + spotlights each sidebar section; auto-degrades to centered cards on mobile; replayable via Settings → "Take the tour". Migration 110 (`profiles.commercial_onboarding_seen_at`).
- [ ] **Getting-started checklist** on the dashboard (lights up as data appears, auto-hides)
- [ ] **Field-ops purchase/hours form redesign** (photo-first, receipt on top, worker auto-filled, date=today)
- [→ Bonus] ~~**Faster pipeline actions**~~ — **moved to Bonus features** (Karan 2026-08-04: "not necessary right now").
- [ ] Account header open-opportunity count + balance · alphabetical-by-customer sort
- [ ] Edge-case + flow/logic bug-test (before + after) · tsc/tests/build green · pushed

## 🔄 Phase R8 — Hardening
- [x] **Security — DOMPurify-grade email sanitizer** (2026-08-04) — isomorphic-dompurify at ingest (mXSS/DOM-clobbering resistant), jsdom external, webhook pinned nodejs, links forced target=_blank rel=noopener. Tests → security invariants.
- [x] **Security — timezone date sweep** (2026-08-04) — platform already ET-safe; fixed the competitors "Last seen" straggler.
- [x] **Accessibility — focus-trap the slide-out sheets** (2026-08-04) — reusable `<FocusTrapAside>` on all 4 URL-driven sheets (focus in/restore, Tab trap, Esc close, single dialog).
- [→ Bonus] ~~**View-only access role**~~ — **moved to Bonus** (Karan 2026-08-04). Needs a per-mutation sweep (~44 actions + 22 routes; `assertCommercialAccess` also gates reads so no single chokepoint) — must ship complete/fail-closed, so it's its own focused build.
- [x] **Cleanups** — verified no-op: the "orphan" TeamTab/NotesTab are live (actions redirect to ?tab=team); tile-consolidation is a risky refactor that doesn't belong in hardening.
- [ ] _(remaining)_ contrast + focus-ring micro-sweep → folded into the ENDGAME accessibility audit.

## 🔄 Phase R9 — Dark mode finish
- [x] **Code-level dark mode VERIFIED COMPLETE** (2026-08-04). Whole-platform sweep found zero breakers: 0 hardcoded `bg-white` (the 1 is an intentional logo chip), 0 default grays/slate/zinc/neutral, 0 arbitrary/inline hex, 0 hardcoded SVG fills; charts are fully token-based (`toneVar`→CSS vars); every surface incl. the newest (reports, onboarding tour, focus-trap sheets) uses adaptive tokens; theme toggle (cookie + data-theme, no flash) works. The v4 token remap (Karan 2026-07-29) + RUX-0 already did the heavy lifting.
- [ ] _(remaining — VISUAL only)_ subjective contrast micro-polish needs eyes-on-pixels: Karan spot-checks dark live and flags any surface that reads poorly → fix those specifically (don't blind-tweak the deliberately-tuned token values). Folds into the ENDGAME visual audit.

## 🔄 Phase R10 — Field Ops / Scheduling  🐘 (the giant) — VERIFIED vs spec 2026-08-09, ~complete
_Audited view-by-view against `project_tomco_scheduling_spec_2026_08`. Built + shipped; the 3 gaps found are now closed (2026-08-10)._
- [x] Data model + per-job phases (`commercial_job_phases`) + role gating (admin + crew magic-link; the 5 granular field-ops roles were consolidated to the platform RBAC + admin-gate — deliberate)
- [→] Week Grid view — **deliberately RETIRED (R10.7)**; the interactive Calendar is the one scheduling surface (Scheduled/Actual/Variance split: Calendar schedules, Approvals shows variance)
- [x] Calendar view (interactive, month grid + mobile agenda, click-to-schedule, emails crew)
- [x] Job Board view (`/board`)
- [x] Daily Log — **individual clock-in via magic link** replaces the foreman paper-log (deliberate; arguably better accountability)
- [x] Approvals view (scheduled-vs-actual variance, `/approvals`)
- [x] Admin view (employees + jobs CRUD; job creation requires a code)
- [x] Time-entry state machine (submitted→questioned→approved→exported) + payroll-export lock
- [x] Payroll CSV export — W-2-only, reg/OT split at 40h/week (Mon–Sun bucketed)
- [x] Clock-in/out (clock-station) + auto-close stale punch + Spanish-first errors
- [x] **★ Work Order → scheduler connection** — sending a WO auto-creates a schedulable job (`ensureJobForWorkOrder`, carries `work_order_id`, revives soft-deleted twins); overview surfaces the unscheduled backlog.
- [x] **Absences UI (gap closed 2026-08-10)** — PTO/Sick/Personal/Holiday/No-work/Not-available on the Calendar; shows who's off, warns (not blocks) on double-book; attendance-only v1.
- [x] **Copy Week Forward (gap closed 2026-08-10)** — one-click week duplication, skips off/existing/closed, no email spam.
- [x] Assignment publish — RESOLVED: placing a crew member emails + shows immediately (placing = publishing); only bulk copy stays quiet by design.
- [ ] _(remaining)_ optional polish: absence visibility on Overview/Approvals; per-job PHASES scheduling UI (table exists, no dedicated UI yet); Overtime forecast report exists on Overview.

---

## ⭐ Structure & conventions to REUSE in every future phase (Karan's liked patterns)
_Locked 2026-08 after the RUX overhaul. Build new surfaces to THESE._
- **Per-tool dual/triple surface:** account-nested detail route
  `/commercial/accounts/[id]/<tool>/[dealId]` with `variant: "route" | "inline"`
  (standalone AND inline as a deal tab) + a cross-account **sidebar index**
  `/commercial/post-job/<tool>` (status queue + KPIs) + an **account rollup**.
  Reflect everywhere instantly (opp ↔ account ↔ global).
- **ToolBackHeader + `?back=` whitelist** for context-aware back-nav.
- **Hub pattern** for crowded settings/admin (one sidebar item → card grid, see
  `/commercial/settings`). **Collapsible sidebar group** when a section > ~6 rows.
- **Shared primitives** `components/commercial/ui.tsx` + **`DateField`** for ALL
  dates (never native) + **`AutosaveForm`** + **tap-to-sign** + **docs-per-tool
  auto-file** to the deal Documents (category per tool) → account rollup.
- **Palette:** brand **blue** (`cc-brand`), **green** = success, **rose** = danger
  ONLY. No red/purple/teal/yellow on status chrome. ⚠ `cc-brand` === `ppp-blue`
  hex — use `ppp-navy`/`emerald`/`ppp-green` when two states must look distinct.
- **Notifications:** `dispatchCommercialNotification` (bell + opt-in email) + per-
  user opt-in toggles on Settings → Access (Approver + Receiver pattern).
- **Money/KPI:** mini-KPIs + progress bars lead; single source per object; pre-tax
  subtotal = the contract number; never hard-reject money (cap/allow/credit +
  small heads-up). **Never a dead-end** (every empty state links out).
- **Migration-gated deploy** (hand Karan the SQL, hold the push). **Mobile-perfect**
  (44px targets — the CEO reads it on his phone).

## ⬜ Katie's notes + Tomco-doc backlog folded into future phases
_From `project_katie_notes_remaining_2026_08`, `project_katie_general_notes_2026_07_21`,
`project_commercial_master_plan_2026_07_24`, and the Tomco PDFs
(`reference_tomco_doc_formats_verified`, `project_tomco_proposal_format`)._
- [ ] **Kim: build + SEND proposals via Resend** — email the proposal PDF straight
      to the GC from the platform (outbound Resend), tracked. Ties to R1 approval.
- [x] **CO lines ON the invoice** — DONE. Invoice line items + milestones carry
      `change_order_id` (mig 093); status engine reconciles CO lines. (Katie item G.)
      Only a verify-vs-Tomco's-real-bill remains if ever questioned.
- [~] **AIA templated Excel** — BUILT (`lib/commercial/aia/export.ts` fills the
      G702/G703 cells via ExcelJS per `TEMPLATE_MAP.md`). REMAINING: verify the
      output matches Tomco's BLANK template cell-for-cell — **blocked on Katie
      sending the real `.xls` + a sample filled copy to diff against.** (Katie item H.)
- [x] **Custom notification rules + shared daily cron** — DONE. Full rule builder
      on Settings → Notifications (create/enable/delete, triggers + bell/email
      channels, owner-scoped, daily cron). (Katie item L, Block 3.)
- [→ Bonus] ~~**Slack integration**~~ — moved to Bonus (Karan 2026-08-04: "we don't
      need this now"). Only if the Tomco team lives in Slack — bell + email cover it.
- [→ Bonus] ~~**Lien-waiver STORE**~~ — moved to Bonus (Karan 2026-08-04). Today's
      upload-only + coverage tagging is correct if GCs supply their own waiver forms;
      a generate-from-template store is only worth it if Tomco issues its own. Ask Katie.
- [ ] **Reports** (Katie item K, ⛔ needs Katie's report list) — see R4.
- [ ] **Field Ops / Scheduling** (Katie item J) — see R10 + the scheduling spec.
- [ ] **Doc-fidelity guardrail:** every generator (proposal · transmittal ·
      12-month VP warranty · AIA G702+G703 · work-order = room-finish-schedule ·
      timesheet grid · price list 63 rows) must stay true to the VERIFIED Tomco
      samples in `reference_tomco_doc_formats_verified`. Re-check on any template edit.
- [ ] *(Parked / blocked)* Letter-of-Transmittal S-Docs e-sign integration
      (LoT + S-Sign ⛔) — revisit when Katie confirms the S-Docs path.

## 🎁 Bonus features (do at the very end — nice-to-haves after the core roadmap)
- [ ] **Pipeline speed** (deferred from R7, Karan 2026-08-04) — per-column **quick-add** on the kanban (type title + searchable account + Enter → deal born in that stage, optimistic insert), a **"start in stage"** selector on the New-opportunity slide-out, and rapid multi-entry (Enter = create+keep-open). Open stages only; desktop kanban; reuses `createCommercialOpportunity` + the column→(status, sub_status) map.
- [ ] **View-only access role** (deferred from R8, Karan 2026-08-04) — a 4th least-privilege role (see-all, do-nothing). Fail-closed: migration adds 'viewer' to the role CHECK, add `requireCommercialWrite` gate, sweep EVERY mutation (~44 actions + 22 API routes) classifying read-vs-write, hide write UI via `capabilitiesFor`, then an adversarial pass proving no write path is unguarded. Ship complete or not at all.
- [ ] **Slack integration** (deferred from Katie backlog, Karan 2026-08-04) — add a "slack" channel to the notification-rule builder (`RULE_CHANNELS` is bell/email/both today) + a workspace incoming-webhook, so commercial notifications can fan into Slack. Only if the Tomco team uses Slack.
- [ ] **Lien-waiver template store** (deferred from Katie backlog, Karan 2026-08-04) — a library of blank waiver templates (conditional/unconditional × progress/final) generated + pre-filled from invoice data, instead of today's per-payment upload. Only if Tomco issues its own waivers (confirm with Katie — many GCs supply their own form).
- [ ] **Proposal PDF → Operating-Company identity** (deferred from the 2026-08-06 audit, R4 #7) — the customer proposal PDF deliberately renders Tomco's fixed 1:1 letterhead (bundled logo + hand-matched format), NOT the Operating-Company identity every other doc uses. Only worth building if PPP rebrands or runs a **second operating company**; must be reference-tested against Tomco's real proposal so the daily customer document doesn't shift. (Also surfaces the collected-but-unused `fax` + `legal_name` fields.)
- [ ] **Proposal editor "Back to Proposals" breadcrumb persistence** (deferred from the 2026-08-06 audit, R4 #11, LOW) — the editor honors the `?back=/commercial/proposals` origin only on the initial GET; after any save/approval/error action it falls back to the deal's proposals (a valid place, not a dead-end). Full fix = threading `?back` through 15+ approval/error redirect actions + their forms — disproportionate for the payoff, parked here.

## 🟡 ★ ENDGAME — full platform audit (2026-08-06: 7 orchestrated, adversarially-verified rounds — ~100 findings fixed)
- [x] Money / KPI / backend audit — every finding fixed (rounds 1–2 + safety-net lanes every round; AIA/CO/P&L reconcile, deal ⊂ account ⊂ platform)
- [x] UI/UX + flow audit — every finding fixed (rounds 3–7; confirmations, loading states, view-state, cross-page flow)
- [x] Mobile audit — every finding fixed (375px sweeps every round; tap-targets, overflow, iOS-zoom fonts)
- [ ] Accessibility audit — every finding fixed (**not yet a dedicated pass** — a11y is the one remaining ENDGAME lane; focus rings + labels + contrast micro-sweep)
- [x] Security audit — every finding fixed (round 1 security lane + safety-security lane every round; authz gates, IDOR, public-endpoint guards, soft-delete PDF gating)

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
