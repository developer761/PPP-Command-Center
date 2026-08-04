# Phase R10 — Field Ops / Scheduling & Labor 🐘

_The giant. Build LAST (per Karan). Source of truth: `project_tomco_scheduling_spec_2026_08` (Katie's v1.0 spec) + Karan's phases addition. This doc is the build plan on top of that spec._

Replaces Tomco's weekly scheduling spreadsheet (which does 3 jobs at once: forward schedule + timesheet record + unscheduled backlog, with no employee/job master list). W-2 crew scheduling → labor tracking → payroll handoff. **Clean start, NO historical import.** Contacts: stephanie@ / brendan@tomcopainting.com.

---

## Locked design principles (expensive to reverse — bake in from row 1)
1. **Names are labels, IDs are keys.** Every employee + job gets an immutable UUID; nothing joins on a typed string. (Today's labor rows use free-text worker names — R10 introduces the real `employees` master; the old free-text path stays for cost-only until reconciled.)
2. **Scheduled ≠ actual.** `assignment` = what SHOULD happen; `time_entry` = what DID. Never share a field.
3. **Crews are templates, not schedulable entities.** Dragging a crew onto a job writes ONE assignment row per member (individually editable). A crew never holds hours.
4. **Job code mandatory at creation** — enforced structurally (the create form can't submit without it).
5. **Sensitive data isolated.** Pay rates in a separate permission-gated table; absence reasons are enum codes, never free text.

---

## Data model (all net-new, migrations 112+)
- **commercial_employees** — id, first/last/display_name, worker_type (`w2`|`sub`|`temp` — gates payroll), role (foreman|painter|taper|laborer|apprentice), pay_type, default_daily_hours (8), phone/email, sort_order (stable grid column order), active (never delete), start/end_date, **schedule_email_opt_out (bool, default FALSE — everyone gets their weekly schedule unless they opt out)**, **preferred_language (en|es — bilingual schedule emails)**, **clock_pin_hash (4-digit PIN, hashed — for the Clock Station kiosk)**, **magic_link_token (rotating, for the personal schedule + clock link)**.
- **commercial_employee_rates** _(RESTRICTED — own permission gate)_ — employee_id, cost_rate (burdened), rate_type, effective_from/to. Only job-costing reports read it; scheduling UI never does.
- **commercial_crews / commercial_crew_members** — crew (id, name, foreman_employee_id, active); members (crew_id, employee_id, added_at/removed_at — membership historical).
- **commercial_jobs** — id, job_code (unique, REQUIRED), name, **opportunity_id (nullable — a job can be backed by a won deal, or standalone)**, customer_id/name, site_address/city/state/zip, lat/lng (nullable), status (state machine below), estimated_labor_hours, target_start/end, prevailing_wage (bool), notes.
- **commercial_job_phases** _(Karan's addition)_ — id, job_id, phase_no, label, start_date, end_date. Model multiple date ranges per job (Phase 1 Aug 1–6, break, Phase 2 Aug 15–20). SF captures only 1 start/end — this fixes that.
- **commercial_assignments** _(THE SCHEDULE)_ — id, job_id, employee_id, work_date, scheduled_hours, **scheduled_start_time (nullable — for 2-jobs-a-day windows, e.g. Job A 7–11, Job B 12–4)**, crew_id (nullable = provenance), status (planned|published|cancelled), note. **UNIQUE(job_id, employee_id, work_date)**; one person on 2 jobs/day = 2 rows, each with its own start_time.
- **commercial_absences** — id, employee_id, work_date, type (PTO|SICK|PERSONAL|HOLIDAY|NO_WORK|NOT_AVAILABLE), hours, note (ops only). The P/S/NW/NA vocab as structured values.
- **commercial_time_entries** _(ACTUALS, daily aggregate)_ — id, assignment_id (nullable = unplanned), job_id/employee_id/work_date (carried independently), actual_hours (**auto-summed from punches** OR manual), status (submitted|questioned|approved|exported), pay_period_id, submitted_by/at, approved_by/at, questioned_reason.
- **commercial_time_punches** _(CLOCK IN/OUT — the raw events, Karan 2026-08-04)_ — id, employee_id, job_id, assignment_id (nullable), clock_in_at (timestamptz, **server clock, not the phone**), clock_out_at (timestamptz, null while on the clock), source (self_link|foreman|admin), edited_by/at, note. Multiple per day (2 jobs at different times = 2+ punches; a lunch break = clock-out then clock-in). Segment hours = out − in; the day's time_entry.actual_hours = Σ that employee/job/date's punches.
- **commercial_pay_periods** — id, start/end_date, status (open|review|exported|closed), exported_at/by.
- **scheduling audit_log** — REQUIRED on time_entries, assignments, employee_rates (reuse the existing commercial audit-log pattern).

## State machines
- **Job:** estimating → ready_to_schedule → scheduled → in_progress → complete → closed; `on_hold` branch off scheduled/in_progress. `ready_to_schedule` = the backlog the calendar drags from.
- **Assignment:** planned → published → cancelled. Publishing makes the week visible to foremen.
- **Time entry:** submitted → (questioned → back to foreman) → approved → exported.

---

## Roles (new — folds in the deferred RBAC work)
Admin (all + rates + reopen periods) · **Scheduler** (create/publish assignments, manage jobs/crews, approve time) · **Foreman** (view own crew's published schedule, submit own crew's actuals) · **Payroll** (view approved time, export, read rates) · Viewer (read-only, no rates). **Rate visibility = Admin + Payroll only.**
> Pulls the role model past today's admin/account_manager/rep. Uses the same fail-closed `requireCommercialWrite`-style gating flagged in the Bonus view-only-role item, but scoped to field-ops surfaces + the rates table.

---

## The 6 views
- **R10.1 Week Grid (primary)** — jobs down the left, employees across the top, hours in cells, Mon–Sat sections, employee cols by sort_order (sticky header). **Mode toggle: Scheduled · Actual · Variance.** Col totals/employee, row totals/job, week grand total. Click-to-edit cells (type a number → create/update assignment). **Copy Week Forward.** In-grid flags: over default_daily_hours, working-day with no assignment + no absence, job over estimated hours.
- **R10.2 Calendar — interactive + polished (Karan: "look amazing, cool features")** — Month (each day: jobs running + headcount, day total, absences strip) + Resource timeline (employees = rows, days = cols, 2–6 wk scroll, colored job blocks, splits stacked, gaps = idle capacity), toggle between the two. **Interactions:** drag ready_to_schedule job → day · drag crew → job-day auto-expands to member rows · drag a block to move/extend across days · click a day to quick-add · planned = reduced opacity until published. **Delight/features:** per-job color chips (stable per job) · **today ring** + weekend/holiday shading · live **headcount + idle-capacity heat** (under/over-scheduled days tinted) · **conflict highlighting** (a painter double-booked at the same time glows rose) · hover/tap card with job code, site, crew, scheduled vs clocked · **filter chips** (crew/foreman/job/status/PW) with instant re-render · smooth 150ms transitions, on-brand blue/green, fully mobile (month collapses to an agenda list on a phone) · optional **map pin peek** later (jobs carry lat/lng). Never a dead-end — an empty day says "drag a job here or + add."
- **R10.3 Job Board** — kanban by job status; cards show code/name/site/target dates/scheduled-vs-estimated burn; `ready_to_schedule` column = the drag source.
- **R10.4 Daily Log (MOBILE-FIRST, <30s, PER-PAINTER)** — Karan 2026-08-04: **each painter submits their OWN time** (not foreman-per-crew). The field crew is low-tech-comfort (see [[feedback_ppp_one_click_autofill]]), so access is a **magic link** (tokenized URL emailed to them — no password, phone-first), NOT a full account. Painter taps the link → sees TODAY pre-filled at their scheduled hours for their assigned job(s) → one tap **Confirm**, or nudge one number → submit. Absence = tap a reason code (P/S/NW/NA). Optional unplanned job-hours row if they worked somewhere unscheduled. Submit locks their day pending approval. (Speed is the whole game — >30s and it won't happen daily, regressing to "every cell = 8".) A **Foreman/Scheduler can still submit on behalf** of someone who can't.
- **R10.5 Approvals** — pay-period queue for scheduler/admin; group by employee|job; side-by-side scheduled vs actual + variance; bulk-approve zero-variance; question an entry (→ foreman); period can't export while any entry is submitted|questioned.
- **R10.6 Admin** — CRUD employees/crews/jobs/pay-periods. Job create form won't submit without a job_code.

## Payroll handoff (light for v1)
At period close: CSV of approved time entries grouped by employee, total hours, **reg/OT split at 40h/wk**, **filter worker_type='w2'** (subs/temps excluded by construction). Export sets period → exported + locks entries. (Gusto API = later; only needs `employees.external_ref`.)

## Reports
1. Labor by job (scheduled vs actual vs estimate, hrs + cost) · 2. Utilization by employee · 3. **Overtime forecast** (projected past 40h mid-week — the one with immediate $ value, doesn't exist today) · 4. Variance · 5. Unassigned capacity.

---

## ⭐ Integration decisions (need Karan's call — flagged in the summary)
1. **Jobs ↔ opportunities:** RECOMMEND a job can be **backed by a won opportunity** (`opportunity_id` nullable) — pull site/customer/estimated-hours from it — OR created standalone (PW/T&M jobs not in the deal pipeline). Mirrors "not a silo."
2. **WO → scheduler (Karan's explicit ask):** sending a Work Order → **option** to place/sync it as a scheduled job: crew + window + scope seed the job's first assignments from the WO's `assigned_to` + `scheduled_start/end`. Two-way sync; the scheduler surfaces **"WOs sent but not yet scheduled."** A job can be BACKED BY a WO (`work_order_id` nullable) — the scheduler is not a silo.
3. **Labor cost reconciliation:** today's free-text labor purchases feed job cost/P&L. RECOMMEND keep them **parallel for v1** (time_entries = the scheduling actuals; labor purchases stay for cost) and reconcile later — clean start per the spec. Optionally, approved time_entries × employee_rate can later *become* the labor-out figure.
4. **Employees seed:** clean start (spec). Optionally offer a one-time "import distinct worker names from labor history → draft employees" convenience, off by default.

## 🔗 Connects to the rest of the platform (NOT a silo)
R10 must wire INTO what's already built, not sit beside it:
- **Won Opportunity → Job.** A won deal can spawn/back a schedulable job (site, customer, estimated hours flow in). "Won but not yet scheduled" is a surfaced queue, same spirit as the deal→project handoff.
- **Work Order → Schedule.** Sending a WO offers to place it on the schedule; crew (`assigned_to`) + window (`scheduled_start/end`) seed the job's first assignments; two-way sync; "WOs sent but not scheduled" surfaced. (Karan's explicit 2026-08 ask.)
- **Job phases → billing/AIA reality.** Multiple date ranges per job (Karan) — the schedule reflects real phased work, unlike SF's single start/end.
- **Labor actuals → Costs & P&L.** Approved `time_entries` × `employee_rates` is the honest labor-out number; reconciles with (and can eventually replace) today's free-text labor purchases that feed the Costs tab + portfolio P&L. Prevailing-wage jobs flagged for correct cost/report treatment.
- **Reports framework (R4).** Labor-by-job / utilization / overtime-forecast / variance / unassigned-capacity slot in as **Reports tabs** (same `ReportTabs` framework + CSV export pattern), not a separate reporting silo.
- **Notifications.** Schedule published → notify foremen · time questioned → notify that foreman · pay-period ready/exported → notify payroll — all via `dispatchCommercialNotification` (bell + opt-in email), same as every other event. Custom-rule + (bonus) Slack channels get these for free.
- **Account timeline.** Job scheduled / completed drops a system note on the account, like proposals/invoices do.

## ⭐ Reuses the LOCKED conventions (build to these, per the RUX overhaul)
Per-tool **dual/triple surface** (account-nested detail + cross-account **sidebar index** + rollup) · **ToolBackHeader + `?back=`** context-aware back-nav · **Hub pattern** for the Field-Ops landing / a **collapsible sidebar group** (it's >6 rows) · shared primitives + **DateField for every date (never native)** · **AutosaveForm** where it fits (grid cells, daily log) · **docs-per-tool auto-file** (payroll CSV filed to the pay-period) · **palette** blue/green + rose-danger only, `ppp-navy` when two states must differ (never purple/yellow) · **never a dead-end** (empty schedule → "add a job / import a crew") · **money never hard-rejects** · **mobile-perfect 44px** (the Daily Log is mobile-FIRST) · **migration-gated deploy** (hand Karan the SQL, hold the push) · edge-case audit before + AND after each sub-phase.

## ⏱️ Clock in/out — how it works + integrates (Karan 2026-08-04)
**No app, no hardware kiosk (v1).** It's the SAME mobile web page behind the painter's magic link — the clock lives where they already confirm hours. **Timestamps are the SERVER clock, never the phone** (a painter can't back-date). Flow:
1. Morning: painter taps the magic link → "Today: **Job A** 7:00–11:00 · **Job B** 12:00–4:00" (from their assignments' start_times).
2. Big **Clock In** on Job A → writes a `time_punch` (clock_in_at = server now). Screen flips to "On **Job A** since 7:03 — **Clock Out**."
3. Lunch/done → **Clock Out** → clock_out_at = now → segment = 3.9h.
4. Second job → **Clock In** on Job B → new punch → Clock Out. (2 jobs/day at different times = 2 punches — handled natively.)
5. Day auto-totals per job (Σ punches → each job's `time_entry.actual_hours`); painter taps **Submit day** (or it auto-submits on the last clock-out) → locked pending approval.
6. Scheduler sees **clocked actual vs scheduled** in Approvals → approve or question.
- **Break handling:** clock out for lunch → clock back in = break naturally excluded (no separate break UI in v1; optional per-company "auto-deduct 30-min lunch after 6h" is a config flag, OFF by default).
- **Confirm-hours fallback stays:** if they never clocked (dead zone, forgot), they — or a foreman — enter the hours manually; the entry is tagged `manual` vs `clocked` for the audit trail.
- **Geofence/GPS = phase 2** (out of scope v1 per spec). We can optionally capture coarse browser geolocation on a punch later for verification; v1 is timestamp-only.

### Backup: in-platform **Clock Station** (Karan 2026-08-04 — for when the magic link fails)
A self-service clock page reachable inside the scheduling area (works on a shared shop tablet OR any painter's browser when their link is broken): **pick your name/email → enter a 4-digit PIN → pick today's work order/job → Clock In · Clock Out · Lunch.** Same `time_punches`, same server timestamps as the magic-link path — a redundant road to the identical data.
- **PIN (set in Admin per employee)** stops buddy-punching on a shared device — the one real risk of a name-picker kiosk. Admin can reset a forgotten PIN.
- Only shows the picker's **own** assigned WOs/jobs for today (+ an "other/unplanned" option). One active punch per employee at a time — clocking in elsewhere blocks/closes the open one (same rule as the link).
- The magic link stays the primary/easiest path; the Clock Station is the fallback + the shop-tablet option.

### Clock in/out edge cases (baked in)
- **Forgot to clock OUT** (went home on the clock): the punch stays open; a "you're still clocked in on Job A" nudge; on rollover it's flagged, and Approvals **can't approve an open punch** — scheduler/foreman closes it to the scheduled end (audit-logged).
- **Forgot to clock IN**: retro-add a punch or use the confirm-hours path → tagged `manual`.
- **Double-active** (clock into B while still on A): block it — "Clock out of Job A first" (or auto-close A at B's clock-in, flagged).
- **Wrong job**: re-point the punch to the right job before submit (painter) or anytime (foreman/scheduler), audit-logged.
- **Unplanned job** (clocked in somewhere not scheduled): allowed → time_entry with null assignment (the spec's unplanned row).
- **Offline on site**: the page needs signal to punch; no signal → confirm-hours later or foreman submits (native offline is out of scope — call it out honestly).
- **Double-tap / duplicate punch**: debounced + idempotent.
- **Tampering**: server timestamps only; any edit to a punch/entry writes an audit row (payroll-adjacent).
- **Timezone**: stored UTC, shown ET; the "work_date" a punch belongs to is derived in ET (a 9pm–1am punch stays on the start day).
- **Two Robs / display collisions**: punches key on employee_id, never the name.

## 🔔 Schedule emails + opt-out — Settings → Access, new "Schedule Emails" section (Karan 2026-08-04)
- **Everyone gets their personal weekly schedule email by default.** Opt-out is per-person: a toggle in the new **Access → Schedule Emails** section (admin can flip anyone off), PLUS an **unsubscribe link** in the email itself (sets that employee's `schedule_email_opt_out`). Re-subscribe from Access.
- **Internal recipients (office):** a managed list (Stephanie, Brendan, …) who get the **full weekly schedule** summary (all crews) — separate from the per-painter personal emails. Same section.
- Sits alongside the existing per-user Approver/Receiver toggles on Settings → Access, so all "who gets what email" lives in one place.

## 📧 Painter comms — "here's your schedule" email (Karan 2026-08-04)
When a week (or a day) is **published**, each painter gets an email of THEIR assignments — not the whole grid:
- **Per painter, personalized:** "Here's your schedule, Miguel:" → each day → the job, the site address, start time, foreman/crew, and job details (pulled from the job / its **Work Order** if backed by one — scope, finishes). PW jobs flagged.
- **One tap to confirm hours:** the email's magic link opens that painter's mobile **Daily Log** (pre-filled) — email + capture are the same low-friction loop. Reuses the Resend `sendEmail` + tokenized-link pattern (customer-form invite + WO crew-email precedents).
- **Re-send / change alerts:** re-publishing after a change re-emails only the affected painters ("your Thursday changed"). Never spams the unchanged.
- Bilingual-ready copy (crew is largely Hispanic, low-tech-comfort) — short, concrete, one action.

**Email triggers (Karan 2026-08-04 — "everyone gets emailed"):**
- **Weekly schedule published** → every non-opted-out employee gets their personalized week. (Default ON for all.)
- **Assigned to a Work Order** (the person named on a WO for a job) → they get that WO's details + when they're scheduled — ties the account→deal→**team-assignment→WO→schedule** chain together, so adding someone to a deal's team + cutting their WO loops them in automatically.
- **Their day changed after publish** → only the affected people get a "your Thursday moved" note.
- **Consolidation, not spam:** a person on 2 WOs/jobs in a day gets ONE email with both (with times), never two. Daily/weekly digest, not per-row.
- All respect the single opt-out + the internal-recipient list; an employee with no email on file is flagged in Admin (they use the Clock Station + foreman relay).

## 🔄 End-to-end flow (must feel like ONE smooth process — Karan)
`Account (GC)` → `Deal / Opportunity` → **win** → `Work Order` (crew + window + scope) → **"Schedule this job?"** seeds a `Job` + `assignments` from the WO's `assigned_to` + `scheduled_start/end` → **Publish** → each painter **emailed** their schedule + magic link → painter **confirms hours** (mobile Daily Log) → Scheduler **approves** (variance review) → Payroll **exports CSV**.
- Standalone jobs (PPP / PW / misc — the "(ppp job)" reality) skip the deal/WO front-half and are created straight in the scheduler.
- Every hop drops the expected note / notification / rollup so the account timeline, the deal, the WO index, and the schedule all stay in sync — no dead ends, no re-typing. The WO index already shows "not created / draft / sent to crew"; add **"sent · not scheduled"** so nothing falls through the account→deal→WO→schedule handoff.

## Roles — painter access = magic link (not a seat)
Admin · Scheduler · Foreman · Payroll are real logins (RBAC). **Painters do NOT get full accounts** — they access only their own Daily Log via the tokenized magic link in their schedule email (scoped to their own `time_entries`, nothing else). Keeps onboarding to zero for the crew and the write-surface tiny. Rate table stays Admin+Payroll-only.

## Out of scope v1 (per spec)
GPS/geofenced clock-in · materials/paint ordering · sub POs · customer schedule notifications · native mobile (responsive web OK) · Gusto sync · historical import · residential division.

---

## Build order (each sub-phase independently shippable + reviewable, migration-gated)
- **R10.0 Foundation** — data-model migrations + roles + rate gating + **Admin CRUD** (employees/crews/jobs/pay-periods, job_code enforced) + sidebar "Field Ops" section. Nothing schedules yet, but the masters exist.
- **R10.1 Week Grid** — the primary surface (Scheduled/Actual/Variance + click-to-edit + Copy Week Forward + flags).
- **R10.2 Calendar + Job Board** — drag-scheduling + the backlog drag-source.
- **R10.3 Daily Log + Clock in/out + painter schedule email** — per-painter magic-link mobile: clock in/out (server timestamps, 2-jobs-a-day, break-by-gap) with a confirm-hours fallback; published-schedule email to each painter (personalized, WO details, opt-out); the make-or-break usability piece.
- **R10.4 Approvals + time-entry state machine** — variance review + period lock.
- **R10.5 Payroll CSV + Reports + WO→scheduler link** — the $-value outputs.
- **R10.6 Audit + polish** — edge-case + flow + mobile + a11y sweep → leads into ENDGAME round 2.

## Edge cases to bake in
Split days (one person, 2 jobs, 8+8 or 4+4 — the UNIQUE(job,emp,date) supports it) · unplanned actuals (time_entry with null assignment) · absence on a scheduled day (block the "no assignment" flag) · publishing (scheduled-in-progress invisible to foremen until published) · period can't export with open items · rate table never leaks to scheduling UI · a deactivated employee stays in history (never delete) · job_code uniqueness collision · prevailing-wage jobs flagged for reporting · a WO re-sent after scheduling (don't double-create the job) · timezone-safe dates everywhere (DateField + ET).

**Kiosk / Clock Station:** buddy-punching (PIN-gated) · forgotten PIN (admin reset) · picking a WO not yours (only your assignments show + an "other" that's flagged unplanned) · magic-link AND kiosk clock-in by the same person (ONE active punch per employee — the second is blocked/merges) · shared device left on a session (auto-return to the picker after each punch, short idle timeout) · painter not on file (can't pick — Admin adds them first).

**Email "everyone":** employee with no email (flagged in Admin, no send, uses kiosk) · opted-out person still needs info (foreman relay / kiosk) · double emails from 2 WOs same day (consolidated into ONE) · a WO reassigned to a different person (old assignee gets a "removed", new gets the WO) · re-publish churn (only changed people emailed, never the whole crew again) · bounced address (surface in Admin, don't silently drop).

**Interactive calendar:** painter double-booked at the SAME time (conflict-glow, not silently allowed) · drag onto a past day (warn/block) · drag onto a day the painter's absent (warn) · drag a crew where a member is already booked elsewhere that day (that member's cell flags) · a job dragged with no crew (creates the job-day at 0 → prompt "add people") · many jobs×employees (virtualize the timeline; keep it smooth) · month view on a phone (collapses to an agenda list) · ET throughout.

## ✅ Verified against the real timesheet (`Time Sheets - W_E 5_28_26.pdf`, analyzed 2026-08-04)
- **Roster (8, stable column order = sort_order):** Rob C · Greg · JJ L · Joe L · Miguel · Erick · Paul · Rob P. (two Robs → initial-disambiguated display names; Paul + Rob P. rostered but 0h that week). → seeding these 8 is the R10.0 "initiate" step.
- **State vocabulary is THEIRS — use verbatim:** **Scheduled · Approved · Questioned** (not "Actual/Variance"). "Approved" = the confirmed actual. Color-coded in the grid.
- **Absence/day codes verbatim:** P (Personal) · S (Sick) · NW (No Work) · NA (Not Available) · SD (Sick Day) · OUT · Holiday (Memorial Day row). A bare **`0`** in a cell = scheduled-but-didn't-work (Joe L Thu Stark → week total 24 not 32) — the scheduled≠actual case, live in their data.
- **CREW IS SHARED ACROSS DIVISIONS (big one):** "(ppp job)" tags — the same painters do PPP residential + Tomco commercial + misc (Brent Mako, Probst, Enecon) in one week. → **Jobs are STANDALONE-FIRST** (name + code, `opportunity_id` OPTIONAL). PPP/misc jobs are standalone with no cross-platform link (respects platform-separation). Locks integration decision #1.
- **Job code = the discipline we ADD:** the sheet has none (free-text names). Enforcing `job_code` at creation is the reportability upgrade.
- **PW = prevailing wage** (Enecon 6 Platinum Ct) → the `prevailing_wage` flag, confirmed. **Pending/weather notes** (Ascent Duct patches, "OShea… weather and progress pending") = the `ready_to_schedule`/on-hold backlog, shown as red side-notes today → becomes a real queue.
- **Week = Mon–Sat**, Saturday usually OUT, per-employee column totals at the bottom. Week Grid mirrors this 1:1 → zero learning curve; **Copy Week Forward** kills the manual weekly re-type.

## Resolved decisions (Karan 2026-08-04)
1. **Actuals capture = EACH PAINTER submits their own** (via magic-link Daily Log). ✅ (was the open Katie question — now answered.)
2. Jobs **standalone-first** + optional opportunity/WO link. ✅ (confirmed by the "(ppp job)" timesheet reality.)
3. Labor cost: keep today's path **parallel** with time_entries for v1; reconcile later. ✅
4. Build the **Scheduler/Foreman/Payroll role model in R10.0** (where the deferred RBAC lands). ✅
5. **WO → schedule** integration + the **"here's your schedule" painter email** are in-scope. ✅
