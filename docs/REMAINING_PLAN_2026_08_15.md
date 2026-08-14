# Remaining plan — Commercial CC (updated 2026-08-15, post-audit)

Supersedes `REMAINING_PLAN_2026_08_14.md`. Merges last night's plan with the
other session's 4-lens adversarial audit (**52 findings**, ~8 personally
verified — expect ~1/3 of the rest not to survive a hard look, so **confirm each
file:line before acting**). Review-session spot-checks confirmed the top 3
(crew-POST exclusions, bulk-delete CO brick, archive revenue/debt asymmetry).

**Order:** Emergencies → High → Medium → last-night punch-lists (C.9→C.5) → D re-audit → endgame.

---

## 🔴 1. EMERGENCIES — money corruption, data loss, security fail-open (before anything)

### Money can be permanently corrupted
- [ ] **F1** — re-quoting a WON deal swaps the signed contract for a draft (contract/margin/AIA follow). *(last night)*
- [ ] **F2** — AIA G702/G703 stop footing on post-seed change orders; issued certificates silently restate. *(last night)*
- [ ] **M1 — Bulk-delete bricks CO re-billing** ✅*verified* — `invoices/page.tsx:199,280` bulk paths stamp `deleted_at` but never call `releaseTickedChangeOrders` (only `softDeleteInvoice` does); migration `093:49` unique index can't see the parent's `deleted_at`, so the slot is held forever → re-tick = raw 23505, the CO's money can never be re-billed. Fix both bulk paths + correct the index/comment.
- [ ] **M2 — AIA "Original Contract Sum" double-counts COs** (customer-facing G702) — `aia/db.ts:224,392`: `seedAiaScheduleOfValues` appends a G703 row per approved CO AND writes the CO-inclusive total to line 1; on a deal with no sent proposal it double-counts with no user action.

### Wrong numbers on the CEO dashboard
- [ ] **D8 — Archiving a deal removes revenue but keeps debt** ✅*verified asymmetry* — `projects/db.ts:119` filters `archived_at`; the invoice rollups don't. Archive a part-paid finished deal → Gross/Net/Margin drop by the billed amount while "Owed" + AR Aging keep it.

### Silent total data loss
- [ ] **U1 — 4.5 MB upload cliff on the REMAINING surfaces** — I migrated **opportunity attachments** to direct-to-Storage last night (`dceea480`); the audit lists ~5 still multipart: submittal, proposal-markup, lien-waiver (no client size check), invoice attachments, change-order attachments, + 2 server actions. **Worst: New Account → fill the whole form → attach COI/W-9/MSA → 413 at the edge → entire typed form gone.** Same signed-upload treatment; block form loss.

### Payroll / security fail-open
- [ ] **FO1 — Absent-day hours sweep through payroll** — `approvals.ts:195` + `daily-log.ts:182`: marking PTO/Sick doesn't cancel the assignment, so scheduled stays 8h; crew Confirm → variance 0 → "approve all zero-variance" pays it, nothing shows the absence.
- [ ] **FO2 — Unvalidated backdating (chains with FO1)** — `crew/log/page.tsx:46,70`: `job_id`/`work_date` unbounded; post an old no-show date with scheduled hours → variance 0 → bulk-paid; UI only renders today/yesterday so no approver looks.
- [ ] **FO4 — Crew POST writes to the shared exclusions library** ✅*verified* — `exclusions/search/route.ts:53`: GET calls `denyCrewApi`, POST doesn't. **1-line fix.**
- [ ] **FO3 — Crew-log actions skip `assertCommercialAccess`** — `crew/log/page.tsx:34,59`: deactivating a user in Settings→Access while their employee row stays active lets them keep writing to payroll while every other surface 403s them.

### Things vanish / read as their opposite
- [ ] **D1 — Jobs under contract vanish from the By-customer board** ✅*verified* — `opportunities/page.tsx:2016,2199`; `constants.ts:54` comment says three status sets partition all seven "no gap" but the board uses two → everything in delivery falls through. A GC whose only deal is in production shows "0 open bids", no deals listed.

---

## 🟠 2. HIGH — wrong bases, silent filter drops, contradicting reports

**Money**
- [ ] **M3** job costs truncate at 1000 purchase rows (`purchases/db.ts:138`, bare `.select().in()` no paginate/order) → Dashboard/Transactions/Job-Costs understate cost, overstate margin; the deal's own P&L (under cap) disagrees.
- [ ] **M4** "Gross margin" tile contract-based, rows below billed-based (`post-job/costs/page.tsx:30 vs :45`) — 46% over rows of 9%/12%.
- [ ] **M5** two more unpaginated aggregates (`rollup.ts:79` Account-360, `db.ts:336` "Paid this month") disagree past the cap with paginated siblings on the same screen.

**Dashboard / Reports / Pipeline**
- [ ] **D9** win-rate tile vs the report it links count different deals (`win-loss/reports.ts:163` vs `wasWonInPeriod` excludes null `closed_out_at`).
- [ ] **D21** "Active GCs" counts do-not-bid accounts (`page.tsx:437` = `accounts.length`).
- [ ] **D17** completed job renders with the red ✗ "lost" icon (`:2243` keys on `sub_status==='won'`).
- [ ] **D3** Accounts "Bid range" KPI reads $0 permanently, fallback is dead code ✅*(other session verified)*.
- [ ] **D4** every pipeline toolbar control drops `mine/new/lane/estimator` — change sort on a saved view → whole pipeline; CSV export unfiltered; "Filters (N)" undercounts.
- [ ] **D10** Accounts CSV export ignores 4 of 7 filters. **D18** Accounts KPI labels claim whole book while showing a tag slice. **D11** "Wins this month" structurally 0 on 5 saved views (pre-filter set).
- [ ] **D2** Cash Flow counts un-sent-to-Draft invoices as Billed (`issued_at` never cleared) — self-contradicts `isReceivable`.
- [ ] **D5** free-text estimators credited to nobody (`estimator.ts:186` inverts precedence). **D20** three donut slices identical grey (keyed on retired statuses). **D12** two Reports tabs eject (Revenue redirect, Estimator bounces non-admins).

**Notifications**
- [ ] **N6** every threshold invoice alert fires a day late (noon-ET due vs 12:00 UTC cron vs `Date.now()` cutoffs; "0 days before" can never fire, form allows min=0).
- [ ] **N7** "Unread · N" pill ignores the type filter; "Mark all read" then clears all. **N15** doc-expiry dedup ignores recipient (reassign AM → 29 days silent). **N16** `commercial_bid_submitted` has no label entry. **N19** "Awaiting debrief" links to a report with no list.

**Docs / Email / Mobile**
- [ ] **E1** three crew-email paths never check `.ok` — calendar/off/welcome say "emailed" on address-on-file alone. *(same class as the two cron paths already fixed.)*
- [ ] **DOC2** Closeout "Save now" is dead AND loses work (AutosaveForm no action, preventDefault; nav within 2.5s kills the debounce, no beforeunload) ✅*verified*.
- [ ] **DOC4** every `.txt` upload fails 100% (allowlisted at `db.ts:79`, no text branch in magic-byte check) ✅*verified*.
- [ ] **MOB** date "Clear ×" overlaps the trigger (~40 usages, wipes+autosaves); last-row won/lost popover sliced by `overflow-hidden`; 24px exclusion/copy ×'s mis-tap (dials customer / removes neighbour); "Saved" pill never unmounts intercepts taps; 5 slide-outs don't lock scroll.
- [ ] **FO5** night shifts can't be scheduled + get no reminders (`schedule.ts:72` `hoursBetween` rejects end≤start though `clock.ts:355` supports cross-midnight). **FO6** editing WO dates doesn't reach `commercial_jobs.target_start/end` (`jobs.ts:451` copies only at creation). **FO7** "I wasn't working" doesn't `resyncClockReminder` or `logUpdate`.

---

## 🟡 3. MEDIUM — row caps, correctness edges, cosmetic

- [ ] **Unpaginated crons/reads**: `purchases/db.ts:133` (Job-Costs/Geography, no order → costs shift between loads); `overdue-tasks` + `expiring-documents` crons (past 1000 never remind; `evaluateRule` destructures `{data}` w/o error → "found 0" reports success); `reconcileDealStatesFromProposals` (pulls a deal Won on one refresh not the next past 1000 proposals).
- [ ] **D6** date-field TZ (milestone flips "past due" at noon, `[id]/page.tsx:731`). **N14** ⌘K omits `title_override`, same hint for win/loss.
- [ ] **DOC7** closeout transmittal PDF renders for soft-deleted deals (sibling warranty has the guard). **DOC11** contact-email add lowercases, update doesn't → dup rows. **DOC14** Enter in accounts search drops rating/compliance/tag/sort. **DOC17** fresh install "no approvers" is false (admin fallback). **DOC15/12/13/18** orphaned bytes on failed upload · two error paths discard cause · undo toast hides on 5s even when restore failed.
- [ ] **Config note**: fiscal-year reports assume January; `fiscal_year_start_month` is a setting — change it and cash-flow/CO reports diverge from the estimator report.

---

## 4. Last-night punch-lists (still open) — C.9 → C.10 → C.7 → C.6 → C.8 → C.5
Auto-advance follow-ups (A2/A1/A3 + foldAutoAdvanceTargets) · deal drill-in nav (keep items inside the deal) · flow+logic F3–F12 · completeness C1–C9 · re-audit R24–R45 (R1 flip dealMargin to billed first) · consistency H1–H6/M1–M7. Full detail in `REMAINING_PLAN_2026_08_14.md` §1.

## 5. Phase D — full re-audit · 6. Endgame — Reports (Katie) → RFP-email parser → joint smoke test → done.

---

### Refuted / confirmed-good (don't touch)
Claim/release key mismatch + `status='published'` dead filter already fixed platform-wide · OT buckets per Mon–Sun week correctly · no hardcoded TZ offsets, DST handled · crew scoping tight (no rates/PINs/co-worker access, no `allowCrew:true`) · BILLABLE includes `viewed` · balance clamp consistent · AIA retainage ties to the penny · no `$NaN` paths · kanban mapper total over 8 statuses · signed uploads safe (service-role insert, forged parent ids blocked) · no nested forms · no horizontal overflow · archived-email HTML sanitised w/ HMAC BCC.
