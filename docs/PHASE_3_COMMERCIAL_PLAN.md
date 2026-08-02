# Commercial Command Center — Phase 3 Plan

_Created 2026-08 after the 4-persona UX walk (Alex / estimator / PM / Katie). Supersedes the old `PHASE_3_INVOICING_PLAN.md` (that "Phase 3 = Invoicing" shipped as Phase 1)._

Phase 2 (Costs / Job P&L / charts / revenue) is **shipped, audited, and closed**. Phase 3 is the next build block. Ordering is roughly by user-pain and dependency.

---

## 3A — Global Document Search  _(greenlit from UX walk — Katie's #1)_

**Problem:** the filing cabinet is per-opportunity only; there is no `/commercial/documents` route. To pull one COI Katie must remember the account → open it → find the opportunity → scroll the cabinet.

**Build:**
- New route `/commercial/documents` (sidebar item, admin/office visible).
- Cross-account finder over `commercial_documents` (service-role, joins to opportunity + account for context). Filters: filename (ilike), category, customer/GC, opportunity, date range. Paginated (reuse `paginateAll`).
- Result rows: filename · category · customer · opportunity · size · uploaded date → download link.
- **Bulk download** — "Download all" (zip) scoped to a filter/box, priority for the **Closeout** and **Lien Waivers** categories (assembling a GC package). Server route streams a zip; respects the archive-only rule (never surfaces `deleted_at` rows).
- Doc rows everywhere gain **uploaded date + uploader** (Katie #8) — small schema read, render-only if the columns exist; else a light migration to stamp `uploaded_by_user_id`.

**Est:** 4–6h. No new money logic; read + zip.

---

## 3B — Job "What's Due" strip  _(greenlit from UX walk — PM's net-new #6)_

**Problem:** the opportunity Overview shows financial status + five tool cards, but nothing aggregates the **actionable** items, and nothing shows **aging**.

**Build:** a compact "Needs attention" strip at the top of an opportunity's Overview, surfacing only what's actionable, each linking into the tool:
- COs pending approval (`pendingCoCount`)
- AIA app ready to submit (latest app `draft` with completed value) / not-yet-billed period
- Submittals awaiting GC response, with **days waiting** (`submittalAwaiting` + oldest `updated_at`)
- Overdue invoices on this job (count + $)
- Retainage sitting unreleased at closeout

Most inputs already compute on the page (`pendingCoCount`, `latestAppStatus`, `awaitingSubs`, `overdueInvCount`, `retainageHeldCents`) — the work is aggregation + aging + one clean strip component (mirror the dashboard "Needs attention" pattern). Hidden when nothing's due.

**Est:** 3–4h. Render-only over existing data + one aging query.

---

## 3C — Katie's remaining operational notes

Pull from memory `project_katie_notes_remaining_2026_08`. Master "what's left" list (CO-lines-on-invoice, AIA templated-Excel polish, invoices-under-project, lien-STORE, Kim proposal-build + Resend, rollups + Work Order). Triage into this phase vs. later at kickoff.

---

## 3D — Field Ops / Scheduling  _(the big one — build LAST)_

Full spec in memory `project_tomco_scheduling_spec_2026_08` (v1.0): data model + 6 views (Week Grid, Calendar, Job Board, mobile Daily Log, Approvals, Admin) + payroll CSV + per-job phases. **This is where the deferred `scheduler` role lands** — add the role WITH this module (it has no consumer until then).

---

## Parked (not dropped) — from the UX walk, revisit after 3A–3D

- **AR export / statement (CSV/print)** — aging-by-customer for collections calls (Katie #3).
- **View-only access role** — least-privilege commercial login; today any login can void invoices + see every P&L (Katie #7). Pairs naturally with 3D's role work.
- **Faster pipeline actions** — inline "create new GC" in the new-bid picker; proposal-builder entry point on the opportunity detail; one-click stage-advance (auto-submit + undo toast); "Move to…" list/sheet filtered to legal next stages like the kanban already does (estimator #3/#4/#17).
- **Billing signpost** — cross-link Invoices ↔ AIA so a PM knows on day one how a GC gets billed (PM #3).
- Account header open-bid count + balance; consolidate the 3-level deal tab nesting; alphabetical-by-customer sort.

## Known small cleanups (noted, low-risk, do opportunistically)

- Orphaned `TeamTab` / `NotesTab` components in `accounts/[id]/page.tsx` (defined, never dispatched) — remove in a dedicated cleanup pass; `?tab=team/notes` currently redirects to Documents (renders account info, so not a hard dead-end).
- Consolidate the near-duplicate tile components (`SummaryTile` / `AiaSummaryTile` / `CloseoutStat` / `ProjectStat` / `SubmittalStat`) into one shared tile so the five tools stay visually identical.
