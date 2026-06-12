# New Platform — Commercial Operating System

**Status:** Planning · drafted 2026-06-12 from Alex's diagram + Karan's notes
**Codename in invoices:** "New Platform" (final name TBD)
**Engagement:** Tracked separately from Command Center; bills to `Alex_Platform_Invoice_June_2026.md`

---

## 1. The architectural fork (most important sentence in this doc)

The Command Center is a **Salesforce mirror** — it pulls data from SF every 30 min, derives KPIs, and writes back a narrow set of fields (color picks, material types). Postgres is a cache and a side-channel; SF is the source of truth.

The New Platform is **the opposite shape**. Postgres is the source of truth. Salesforce is, at most, a one-shot seed import for legacy accounts and then it's out of the picture. Karan's literal words: *"we dont really need salesforce because the data is not even there and barely there so everything will go straight into this platform and itll be the main platform not just a platform that pulls data from somewhere."*

Concretely:
- Every commercial entity (account, opportunity, project, invoice, change order, etc.) is a row in a `commercial_*` table that the app creates, reads, updates, and is fully authoritative on.
- No SF cache, no derive layer, no scope-snapshot. Just RBAC + scoped queries against Postgres.
- Documents (plans, specs, RFPs, photos, certificates) live in Supabase Storage; rows reference the storage key.
- We can still log a one-shot SF import for the ~2 commercial users' existing accounts so PPP doesn't start cold, but after that SF is irrelevant.

This changes most of what we built for Command Center. We don't reuse `lib/salesforce/*`, `lib/auth/scope-snapshot.ts`, `loadDashboardData`, or the snapshot derive layer. We DO reuse: the topbar/sidebar shell, the notification bell, Supabase Auth + `profiles`, the customer-form pattern (for the public commercial-bid form), the document/email patterns. About 30% of the Command Center is reusable infrastructure.

---

## 2. How the two platforms coexist

Same domain. Same login. On sign-in the user lands on a **platform picker** (or, for users with access to only one platform, auto-routes to that one). The picker is also a persistent switcher in the topbar so an admin can hop between them.

```
gobkflow.com (or pppoms.com or whatever)
├── /                       — marketing landing (existing)
├── /sign-in                — Supabase OAuth (existing)
├── /choose-platform        — NEW: picker after sign-in
├── /dashboard/*            — Command Center (existing)
└── /dashboard/commercial/* — NEW PLATFORM (new tree)
```

The `/dashboard/commercial` tree is a sibling sub-tree under the same `DashboardChrome` layout but with a different sidebar (commercial-flavored nav), a different theme accent (still PPP blue but tighter palette for executive feel), and a "Switch to Command Center" item in the user menu.

### Access control
Today `profiles.is_admin` is a single boolean. We expand to:
- `profiles.has_command_center_access` (default: same as `is_admin || mapped to SF user`)
- `profiles.has_new_platform_access` (default: false; flipped on per-user)
- A new `commercial_user_roles` table for finer-grained roles INSIDE the New Platform: `admin`, `estimator`, `pm`, `superintendent`, `foreman`, `office`, `field`

A worker can have: Command Center only, New Platform only, or both. Inside each platform, their access is scoped further by their role. A PM only sees projects they're on; an estimator only sees opportunities they own; field users only see projects they're assigned to. Admins see everything. (Same scoping pattern as Command Center but project-rooted instead of opportunity-owner-rooted.)

---

## 3. The 9 phases (mapped to the diagram)

Each phase is a build slice with its own schema, surfaces, and edges. Phase numbers match Alex's diagram.

### Phase 0 — Foundation (build FIRST, blocks everything)

**What:** Platform switcher + RBAC + shared shell + DB conventions.

**Tables added:**
- ALTER `profiles` — add `has_new_platform_access BOOLEAN`
- NEW `commercial_user_roles` (user_id, role, granted_at, granted_by_user_id)
- NEW `commercial_audit_log` (id, table_name, row_id, action, before_json, after_json, user_id, at) — for the "Full audit trail on all records" requirement in the diagram's technical notes
- NEW `commercial_settings` (key, value) — global settings (fiscal year start, retainage default %, etc.)

**Surfaces:**
- `/choose-platform` page (if multi-access; auto-skip otherwise)
- `commercial-sidebar.tsx` component (replaces the residential sidebar inside `/dashboard/commercial/*`)
- Shared topbar (same one as Command Center; topbar shows which platform you're in)
- Notification bell reused as-is; new notification kinds added per phase
- Storage bucket `commercial-documents` with signed-URL access policy

**Edges:**
- A user with only Command Center access who manually types `/dashboard/commercial/*` → 403, not 500.
- A user with neither flag → kicked to `/choose-platform` with a "no access" message.
- An admin can grant New Platform access to another user from `/admin/users` (need to add).
- An admin can demote themselves out of New Platform access without breaking the app.
- The platform switcher remembers the last platform via a cookie so a returning user lands on their last surface.

**Estimate:** 1-2 days.

---

### Phase 1 — Account Management

**What:** The "who we work with" layer. Companies, their contacts, their compliance docs, and a perf dashboard.

**Tables:**
- `commercial_accounts` — company details, A/B/C rating, industry, insurance status, vendor compliance status, prequalification status
- `commercial_account_documents` — COI, vendor forms, W9/agreements, safety requirements; storage_key + uploaded_by + expires_at
- `commercial_contacts` — person rows (name, email, phone, title)
- `commercial_account_contacts` (junction) — many-to-many with `role` enum: `decision_maker`, `estimator`, `pm`, `superintendent`, `ap_contact`, `billing_contact`, `site_contact`, `other`. The diagram shows the SAME person can have multiple roles, so junction is the right shape.
- `commercial_account_performance` — derived/cached: bids submitted, awards, revenue, GP%

**Surfaces:**
- `/dashboard/commercial/accounts` — list w/ filter by rating + status
- `/dashboard/commercial/accounts/[id]` — detail with tabs: Info / Documents / Contacts / Performance
- Document upload via drag-drop; expiration tracking on insurance + COI
- Performance dashboard pulls live from opportunities + projects (cross-phase reads)

**Edges:**
- Same company multiple jobs → `commercial_accounts (1) → commercial_opportunities (N) → commercial_projects (N)` cascade.
- A contact's `role` is per-account not per-person — the same individual at one Account could be Billing + Decision Maker, and at another Account could be PM only.
- Insurance/COI expiration → block project activation when expired (gated in Phase 5).
- Document version control: when a new COI is uploaded, the old one is archived not deleted, so historic project rev points back to the correct cert.
- Vendor compliance status changes log to the audit table.
- Soft-delete only (`deleted_at`), so a deleted account's historic projects still resolve.

**Estimate:** 2-3 days.

---

### Phase 2 — Opportunity (Preconstruction)

**What:** Bid tracking from "we heard about a job" to "awarded/lost." The diagram's 12-status pipeline lives here.

**Tables:**
- `commercial_opportunities` — name, account_id, property/project address, type, estimated_value, due_date, salesperson_user_id, current_status
- `commercial_opportunity_status_history` — every status change with old/new/by/at (audit-grade)
- `commercial_opportunity_team` — junction to contacts with role (decision_maker, pm_contact, super_contact, billing_contact, site_contact) — note: opp team can differ from account contacts because the same Account may use different contacts on different bids
- `commercial_opportunity_documents` — plans, specs, RFP, site photos, attachments
- `commercial_opportunity_notes` — free-text + emails (parsed inbound + manual entries)
- `commercial_opportunity_tasks` — assigned tasks (due_at, assigned_to)

**Surfaces:**
- `/dashboard/commercial/opportunities` — Kanban by status + table view + filter by salesperson/status/due-date
- `/dashboard/commercial/opportunities/[id]` — workspace with tabs: Info / Team / Plans+Specs / Site Photos / Notes+Emails / Tasks / Status Timeline
- Status pipeline enforcement: Lead → Qualified → Site Visit Required → Site Visit Complete → Plans/Specs Received → Estimating → Internal Review → Proposal Submitted → Follow Up → Negotiation → Verbal Award → Contract Review → Awarded / Lost / No Bid
- Bid intake (TWO inbound paths from Karan's notes):
  - **Email** — inbound webhook (Resend + a sub-address like `bids@gobkflow.com`); parser extracts sender, subject, attachments → creates an Opportunity in `Lead` status with the email body in notes + attachments saved
  - **Online form** — public form (like the customer color form pattern), tokenless or behind a per-prospect link; submission lands as an Opportunity in `Lead`

**Edges:**
- Status transitions guarded server-side. Lead can go to Qualified but not directly to Awarded. The full graph lives in `lib/commercial/opportunity-status.ts` as a typed DAG.
- "Awarded" auto-creates a `commercial_projects` row (Phase 5) and flips the opp to read-mostly.
- "Lost" requires a `lost_reason` and a `lost_to` (competitor) field for win/loss reporting.
- Inbound email matching: an email from a known account is auto-linked to that Account; from an unknown sender, the opp is created with a placeholder Account + a "needs linking" flag.
- Plans/specs are typically big PDFs (20-100MB). Upload progress + chunked upload required.
- Site photos: GPS-stamped, timestamp shown.
- Tasks can be assigned to non-user contacts (a client's Decision Maker) → "task" becomes "pending request" with no auth required.
- Salesperson can only see THEIR opportunities unless they're an admin (project-level RBAC).

**Estimate:** 3-4 days.

---

### Phase 3 — Estimating / Proposal Workspace

**What:** The actual bid number-crunching + the proposal document that goes out.

**Tables:**
- `commercial_estimates` — header (opportunity_id, status, total_estimated_cost) + sub-totals (labor_hours, labor_cost, materials_cost, equipment_cost, subcontractor_cost)
- `commercial_estimate_labor` — line items: trade/crew, hours, rate, cost
- `commercial_estimate_materials` — line items: item, qty, unit_cost
- `commercial_estimate_equipment` — line items: item, rental_days, daily_rate
- `commercial_estimate_subcontractors` — line items: sub_name, scope, lump_sum_or_unit
- `commercial_bid_qualification_checklist` — per-opp row with 7 booleans (plans received, specs received, site visit complete, scope reviewed, schedule reviewed, labor strategy, material strategy)
- `commercial_proposals` — header (opportunity_id, rev_n, status, sent_at) + body (scope included, scope excluded, assumptions, addenda)
- `commercial_proposal_revisions` — every save bumps `rev_n` and snapshots prior body for diff
- `commercial_rfis` — RFIs (questions to client mid-bid) with response tracking
- `commercial_addenda` — client-issued addenda + clarifications + custom requests

**Surfaces:**
- `/dashboard/commercial/opportunities/[id]/estimate` — multi-section editor
- `/dashboard/commercial/opportunities/[id]/proposal` — proposal builder + PDF preview + send
- Diff view between proposal revisions
- Bid Outcome action: Awarded / Lost / On Hold → updates opportunity status
- Generate PDF proposal (server-side, like the existing PDF tooling)

**Edges:**
- Saving a proposal increments rev_n; rev_n starts at 1.
- `total_estimated_cost = labor_cost + materials_cost + equipment_cost + subcontractor_cost`. Computed column with rebuild on each line edit.
- Bid qualification checklist visible everywhere but doesn't BLOCK proposal submission (PPP wants flexibility) — just shows a yellow "missing X items" badge.
- Scope included / excluded are structured lists (not free text) so they render cleanly in the PDF.
- An estimate with $0 in any major category gets a "review me" flag (likely missed input).
- Sending a proposal flips opportunity status to "Proposal Submitted" automatically.
- RFI response tracking has SLA: open >5 business days → warning.
- Estimator can only edit THEIR opps unless admin (RBAC).

**Estimate:** 3-4 days.

---

### Phase 4 — Contract Award / Preconstruction

**What:** The bridge between "we won the bid" and "project is set up."

**Tables:**
- `commercial_contracts` — opportunity_id, contract_value, retainage_pct, payment_terms_text, signed_date, doc_storage_key
- `commercial_submittal_planning` — per-contract list: product data, samples, finish schedules, lead times (planning stage; actual submittals tracked in Phase 5)
- `commercial_procurement_planning` — material orders + equipment rentals planned
- `commercial_contract_requirements` — insurance, bonding, safety plans, permits, certified payroll, other compliance

**Surfaces:**
- `/dashboard/commercial/opportunities/[id]/contract` — contract entry + scanned upload
- Pre-construction checklist: are insurance, bonding, etc. in place? → blocks Phase 5 project activation

**Edges:**
- Retainage % is typically 5-10% but varies; sane default + override.
- Payment terms parsed loosely: store text + a structured field for "net 30 / net 45 / progress" enum.
- Pre-construction blockers gate Phase 5 — can't activate a project with no insurance cert on file.
- Bonding usually only required on jobs >$X — config in `commercial_settings`.

**Estimate:** 1-2 days.

---

### Phase 5 — Project Setup

**What:** Once the contract is signed, the opportunity becomes a *project* — the operational unit that everything from here forward attaches to.

**Tables:**
- `commercial_projects` — opportunity_id (1:1 in most cases), project_name, address, contract_value, start_date, completion_date, status (setup → active → closeout → closed)
- `commercial_project_team` — junction to internal users with role (pm, superintendent, foreman, safety_contact) — same person can have multiple roles, multiple PMs possible (Karan's note)
- `commercial_project_documents` — signed contract, SOW, general conditions, insurance certs, permits
- `commercial_submittals` — product data, samples, shop drawings, finish schedules — each with status submitted / reviewed / approved
- `commercial_project_requirements` — insurance, safety plan, permits, certified payroll, other compliance — each with status submitted / reviewed / approved

**Surfaces:**
- `/dashboard/commercial/projects` — list
- `/dashboard/commercial/projects/[id]` — main project surface with tabs for everything from here forward
- Team picker: add/remove PMs, supers, etc. — multi-select (Karan: "Different project managers add them, add different people to projects")

**Edges:**
- Project is created automatically when opp → "Awarded" but stays in `setup` status until pre-construction blockers clear.
- Multiple PMs supported: any PM on a project has full edit rights on that project.
- Field users (foreman, field crew) see only projects they're on.
- Submittal approval flow: submitted → reviewed by PM → approved by client (logged with by-whom + at). Each transition is auditable.
- Permits with expiry dates auto-alert 30 days before.
- Insurance cert expiry blocks new daily reports if lapsed.

**Estimate:** 2 days.

---

### Phase 6 — Project Execution

**What:** Day-to-day project tracking. The heaviest phase, used most by field users on mobile.

**Tables:**
- `commercial_daily_reports` — project_id, report_date, weather, crew_on_site, labor_hours, production_units, notes, delays (free text), submitted_by_user_id
- `commercial_daily_report_photos` — junction to photo storage with optional caption + GPS
- `commercial_labor_logs` — granular: crew, trade, hours by date
- `commercial_material_usage` — purchased / installed / remaining by item by project
- `commercial_equipment_logs` — equipment_id, rental_start, rental_end, daily_rate
- `commercial_subcontractor_records` — contracts, sub_invoices (with approval status), payments
- `commercial_quality_inspections` — inspection_date, by_user_id, findings, photos
- `commercial_punch_items` — description, assigned_to, status (open / in_progress / closed), photos
- `commercial_meeting_minutes` — meeting_date, attendees, minutes, action_items
- `commercial_communications` — client communication log
- `commercial_schedule_milestones` — baseline_date, current_date, status (on_track / at_risk / delayed)

**Surfaces:**
- Daily Report form (mobile-first, 44px tap targets, single column, photo upload from camera)
- Labor / Material / Equipment management tabs with budget vs actual variance
- Subcontractor invoice approval flow (submitted → reviewed → approved → paid)
- Quality inspection + punch item creator
- Schedule view with milestone tracking + look-ahead

**Edges:**
- Daily reports MUST be mobile-perfect. Field users are on iPhones in dusty/wet/sunny conditions. Big tap targets. Camera button prominent. Photo upload chunked so a flaky cellular connection doesn't drop the report. Offline queue: if no signal, save locally and sync when back online (IndexedDB).
- Budget vs actual variance: positive variance = over budget (red); negative = under (green). Always show $ AND %.
- Photo storage: thumbnails generated on upload; full-res accessible via signed URL only.
- Labor hours roll up to project total → feed into job cost summary (Phase 8).
- Material `purchased - installed = remaining`; alerts at <10% remaining.
- Equipment logs auto-bill from rental_start to rental_end.
- Subcontractor invoice triggers a notification bell to the PM + accounting.
- Punch items track open/closed counts on the project header.
- Schedule slip detection: any milestone slipping >7 days → "delayed" status + bell alert to PM.
- Quality inspection deficiencies auto-create punch items.
- Meeting minutes: action items become tasks with assignee + due date.

**Estimate:** 4-5 days. This is the big one.

---

### Phase 7 — Change Management

**What:** Owner requests, field directives, and scope revisions tracked as change orders.

**Tables:**
- `commercial_change_orders` — project_id, type (owner_request / field_directive / scope_revision), description, amount, status, submitted_at, approved_at, approved_by, invoiced_at
- `commercial_co_impacts` — labor_impact_hours, labor_impact_cost, material_impact_cost, equipment_impact_cost, schedule_impact_days

**Surfaces:**
- CO list per project with status pipeline
- CO detail with amount + impacts + signed CO PDF
- CO status pipeline: draft → submitted → pending → approved / rejected → invoiced
- Revised contract calc: original + approved COs, displayed on project header

**Edges:**
- CO amount CAN be negative (deductive CO).
- Pending COs counted in forecast revenue but not in revised contract until approved.
- Schedule impact extends completion date; updates the project's `completion_date`.
- Each status change is audit-logged.
- A rejected CO can be revised + resubmitted as a new CO (no overwriting history).
- COs that hit "invoiced" auto-create an invoice line in Phase 8.

**Estimate:** 2 days.

---

### Phase 8 — Billing & Financials

**What:** Multi-invoice progress billing + retainage + job cost summary. Karan explicitly called this out — pull it up in the build order.

**Tables:**
- `commercial_invoices` — project_id, invoice_number, period_start, period_end, amount, status (draft / sent / paid / partially_paid / void), sent_at, due_at, paid_at, paid_amount
- `commercial_invoice_lines` — type (progress / co / retainage_release / other), description, amount
- `commercial_retainage_log` — held + released per invoice
- `commercial_payments` — invoice_id, payment_method (check / ACH / wire), amount, paid_at, reference_number
- `commercial_job_cost_summary` — view: per-project rollup of labor / material / equipment budgets vs actuals + total contract + COs + forecast GP

**Surfaces:**
- Project Billing tab: invoice list with start/end date filter + paid/unpaid toggle (Karan's explicit ask)
- Invoice detail + PDF generation + send via email (Resend)
- Job Cost Summary card on project header (live updating)
- AR Aging report (cross-project)

**Edges:**
- **Multi-invoice per project** with start/end date — explicit ask from Karan. Schema supports it natively.
- **Paid / unpaid filter** — column + filter button.
- Progress billing %: option to bill by $ amount OR % complete; both convert to $ on invoice.
- Retainage: held until punchlist complete; released as a final invoice line.
- Tax: usually exempt for commercial construction but supports per-invoice override.
- Partial payments: an invoice can have multiple payment records summing to total.
- Invoice voiding: void writes a reversal entry, doesn't delete (audit-grade).
- Invoice numbering: per-fiscal-year sequence stored in `commercial_settings`.
- Forecast GP = `(original contract + approved COs + pending COs) - (labor_actual + material_actual + equipment_actual + sub_actual)`. Updates live.

**Estimate:** 3-4 days.

---

### Phase 9 — Closeout

**What:** Punchlist resolution, final docs, lessons learned.

**Tables:**
- `commercial_punchlists` — internal vs client, items linked to `commercial_punch_items`
- `commercial_closeout_documents` — warranty docs, certificates, commissioning reports, test/inspection reports
- `commercial_lessons_learned` — project_review, what_went_well, what_to_improve, future_action_items

**Surfaces:**
- Closeout tab on project
- Punchlist completion gates retainage release (Phase 8 hook)
- Lessons learned form (required before project → `closed` status)

**Edges:**
- Internal punchlist (PPP self-finds) vs Client punchlist (client-finds) are separate lists.
- Punch items can be reopened after closure (status flips back to open + audit-logged).
- Warranty start date = substantial completion date (computed).
- Closeout doc retention: 7 years per construction industry norm.

**Estimate:** 2 days.

---

## 4. Executive Dashboards & Reporting (cross-phase)

The diagram lists 5 dashboards. Build these AFTER the phases have data flowing.

- **Sales Dashboard** — bid volume, win rate, forecast revenue, pipeline value, hit rate by salesperson
- **Operations Dashboard** — active projects, delays, labor utilization, project schedule status
- **Financial Dashboard** — revenue, gross profit, job costs, AR aging
- **Workforce Dashboard** — crew availability, labor forecast, productivity metrics, safety metrics
- **Company Scorecard** — sales, revenue, gross profit, safety, client satisfaction

**Estimate:** 3 days.

---

## 5. Cross-cutting concerns

1. **Audit trail (the diagram calls it out).** Every UPDATE/INSERT on `commercial_*` tables logs to `commercial_audit_log`. Indexed by row_id so any record's history is queryable.
2. **Role-based access (diagram calls it out).** Each surface checks the user's role + project assignment before rendering or returning data.
3. **Mobile access for field users (diagram calls it out).** Daily reports, punch items, photo upload, schedule view — all mobile-perfect. 44px tap targets. Offline queue for daily reports.
4. **Real-time dashboards & alerts (diagram calls it out).** Reuse the notification bell. New notification kinds per phase. Supabase Realtime channels for live count updates on dashboards.
5. **Document version control (diagram calls it out).** Storage keys are immutable; new uploads bump `version_n`. Old versions stay.
6. **Inbound email parsing** — for bid intake. Resend/Postmark inbound webhook.
7. **Public bid submission form** — for Karan's "bids come from email, online" path.
8. **PDF generation** — proposals, invoices, change orders, signed contracts.
9. **CSV exports** — for finance team.
10. **Search** — global search across accounts, opportunities, projects, contacts.

---

## 6. Reused from Command Center

What we KEEP from the Command Center build:
- Supabase Auth + `profiles` + the admin gate
- The dashboard chrome (topbar + sidebar component pattern, themed)
- The notification bell (just add new kinds + insert helpers)
- The customer-form pattern (for the public bid submission)
- The PDF generation tooling
- The Resend integration (transactional emails)
- The mobile-first design tokens (44px taps, safe-area-inset, etc.)
- The audit/repair admin endpoint pattern
- The supplier-templates + materials-shop UI patterns (similar shape to project documents)

What we DON'T reuse:
- `lib/salesforce/*` — entirely irrelevant for New Platform
- `lib/auth/scope-snapshot.ts` — replaced by `lib/commercial/rbac.ts` (project-based)
- `loadDashboardData` — replaced by direct Postgres queries per page
- The whole `derive` layer — KPIs are direct SQL aggregates

---

## 7. Proposed build order

```
Phase 0  Foundation                          1-2 days   (BLOCKS all)
Phase 1  Account Management                  2-3 days
Phase 2  Opportunity                         3-4 days
Phase 3  Estimating / Proposal               3-4 days
Phase 4  Contract Award                      1-2 days
Phase 5  Project Setup                       2 days
Phase 8  Billing & Financials                3-4 days   (pulled up — Karan flagged it)
Phase 6  Project Execution                   4-5 days   (heaviest)
Phase 7  Change Management                   2 days
Phase 9  Closeout                            2 days
Dashboards                                   3 days
                                          ─────────
Total                                       26-34 days
```

Phase 8 is pulled up so PPP can start invoicing commercial work immediately once they have an awarded contract — even before the heavy execution tracking lands. That accelerates the cash-flow value of the platform.

---

## 8. Open questions for Alex (before we start Phase 0)

1. **Platform name.** "New Platform" is a placeholder. PPP Commercial OS? Commercial Workbench? Bidsuite?
2. **Domain.** Same `gobkflow.com` with `/dashboard/commercial`? Or separate subdomain `commercial.gobkflow.com`?
3. **The 2 SF commercial users — which 2?** They get instant New Platform access on day one.
4. **Legacy SF data import.** Worth doing a one-shot import of existing commercial Accounts + Opportunities? If yes, how far back?
5. **Invoice numbering format.** `PPP-COM-2026-001`? Continue an existing series?
6. **Retainage % default.** 5% or 10% standard?
7. **Bidding inbound email.** Set up `bids@gobkflow.com` or use a sub-address on an existing inbox?
8. **Online bid submission form.** Should be tokened per-prospect (like the customer color form) or open-public?
9. **Field users on mobile — what phones?** iPhone-only or mixed? (Affects camera + offline logic.)
10. **First MVP cutline.** If we needed to ship something in 2 weeks instead of 5, the cut would be: Phases 0 + 1 + 2 (account → opp → "awarded") + Phase 8 (invoicing). Then Phases 3-7 + 9 follow. Is that the right cut?

---

## 9. Edge cases catalog (run through this BEFORE each phase ships)

### Authentication / RBAC
- User has only Command Center access → `/dashboard/commercial/*` returns 403
- User has only New Platform access → `/dashboard/*` returns 403 (or redirects)
- User has both → platform picker on login
- Admin can grant/revoke either access at any time
- Demoted admin keeps their session until next page load → middleware re-checks every request

### Account Management
- Two accounts with the same `company_name` — allowed (different DBAs); UI shows DBA + city to disambiguate
- Insurance / COI expiration — block dependent surfaces (Phase 5 project activation)
- Deleted account with active project — block delete OR cascade with confirmation
- Contact email change — log to audit; warn if contact is on active opportunities

### Opportunity
- Status transitions enforced server-side (DAG)
- Inbound bid email from unknown sender → placeholder Account + flag for review
- Bid received via online form → spam protection (rate limit + Turnstile)
- Estimate deadline missed → auto-flag the opp + bell alert to salesperson
- Lost opp without a `lost_reason` — required field on transition to Lost
- "Awarded" auto-creates project but waits for pre-construction blockers

### Estimating / Proposal
- Estimate edits create revisions, no in-place mutation
- Proposal rev 1 sent, then rev 2 drafted but not sent — UI shows "Draft" badge
- Editing an awarded opp's estimate → blocked or audit-logged with warning
- Subtotal rebuild on every line edit → throttle DB writes
- PDF generation timeout → fail-soft to "Generation pending; you'll get a bell when it's ready"

### Contract Award
- Insurance expired at contract sign → blocked, must update
- Bonding required but missing → blocked
- Retainage % outside 0-20% range → warning
- Payment terms text + structured enum mismatch → flag

### Project Setup
- Project activated without pre-construction complete → blocked
- Removing the only PM from a project → blocked (must reassign first)
- Submittal approval before submission → blocked (status machine)
- Permit expiry mid-project → bell alert at 30/14/7/1 days out

### Project Execution
- Daily report submitted twice for the same date → second one creates an "amendment" linked to the first
- Daily report photo upload fails halfway → resume on retry; partial uploads don't corrupt the report
- Field user offline → IndexedDB queue; sync banner shows "X reports queued" when back online
- Crew on site exceeds project budget hours → bell alert to PM
- Subcontractor invoice exceeds the sub's contract amount → warning, requires PM approval
- Quality inspection finding without a punch item created → enforced via UI
- Schedule slip detection on milestone → bell + dashboard delay count
- Material variance > X% → flag to PM
- Equipment double-booked across projects → warning + override path

### Change Management
- Negative (deductive) CO → allowed, displayed in green
- Pending CO in forecast but not revised contract — separation maintained
- Rejected CO revised + resubmitted → new CO row, not edit
- CO schedule impact → cascades to project completion date
- CO approved without amount → blocked

### Billing & Financials
- Invoice period_end before period_start → blocked
- Invoice amount = 0 → warning (probably an error)
- Partial payment > invoice amount → blocked
- Void on a paid invoice → requires explanation + admin role
- Retainage release before punchlist complete → blocked
- Multiple invoices with overlapping periods → allowed but warning
- Invoice sent before due date hits → bell alert at due_at - 7d, due_at, due_at + 7d (overdue)
- Forecast GP turning negative → red alert on project header + bell to PM + Karan

### Closeout
- Punchlist with open items → blocks `closed` status
- Lessons learned not filled → blocks `closed` status
- Project reopened after closure → audit-logged, must specify reason
- Warranty period expired → archive but keep accessible

### Document Storage
- Upload size > 100MB → chunked upload; show progress
- Upload of duplicate file (same hash) → dedupe at storage layer; reference both
- Signed URL expiry — bake in 1-hour TTL for downloads
- Storage quota approaching → admin bell
- Deleted file referenced by an active record → soft-delete (mark `deleted_at`); file stays in storage

### Audit Trail
- Bulk update of N rows → N audit entries, not 1
- Audit log retention → keep forever (compliance)
- Audit log search by row_id → indexed

### Notifications
- User opts out of a kind → respect per-kind preference
- User on PTO → optional "snooze all" toggle in profile
- Notification with stale link (record deleted) → bell row shows generic title, link 404 → fall back to project root

### Mobile
- iPhone Safari only first; Android later
- Camera permission denied → graceful fallback to file picker
- Photo > 10MB → client-side compression before upload
- Offline daily report → IndexedDB queue; sync banner

---

## 10. Tracking

- Hours bill to `~/Desktop/Alex_Platform_Invoice_June_2026.md`
- Phases referenced by number from this doc
- Each phase ships a memory file in `~/.claude/projects/-Users-karanmalhotra-Desktop-PPP-ppp-command-center/memory/` so future sessions pick up where we left off
- Audit gate before each phase ships: parallel agents on the phase + scope leakage + mobile + edge-case catalog

---

_End of plan. Ship Phase 0 first; the rest unlocks behind it. Open questions in §8 to resolve with Alex before we start building._
