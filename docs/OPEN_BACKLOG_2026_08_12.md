# Commercial Command Center — the one open list

**As of 2026-08-12, end of day.** Everything not finished, from both Claude
sessions, plus everything either of us parked over the last few days.

Nothing here is "probably fine". If an item is a judgement call rather than a
defect, it says so and gives the reasoning, so you can overrule it.

**Currently live:** migrations 126–132 applied · 465 tests · deploy green.
**Pending you:** migration 133.

---

# THE PLAN — as of 2026-08-12, end of day

Plan items 1-10 are **complete and cross-verified** by both sessions. Sections
1, 3.1 and 4.2 below are closed and kept only as record. What is actually left:

| # | Next | Depends on |
|---|---|---|
| **A** | **Run migration 133.** RFP-received dates still save a day early from two of three forms until it lands. | You, 2 minutes |
| **B** | **Full re-audit / walkthrough** of everything shipped today — the restructure, Katie's notes + screenshots, Brendan's list. Scope at the bottom of this file. | Nothing. This is next. |
| ~~**C**~~ | ~~Decide 1.1~~ **SETTLED 2026-08-12 (Karan: "use best judgement").** Archiving a won deal keeps its project archived. The distinction that makes it safe: archiving is an explicit "hide this", un-winning is a status correction — which is why un-winning refuses when the project holds anything. Verified the money does not disappear: reports read opportunities, not projects, so an archived job's invoices, costs and margin still count in AR, P&L, job-costs and geography. Only project-scoped views hide it, which is what archiving is for. | — |
| **D** | **Stephanie's list** | Her findings (0.1) — still not received |
| **E** | **RFP email → auto-populate an opportunity** | Walking real emails through with you |
| **E.1** | **`PPP_ADMIN_EMAILS` in Vercel** — production runs on the hardcoded bootstrap admin list until it is set. Fine while it is you and Katie; set it before more logins exist. | You, 2 minutes |
| **E.2** | **Brendan's sign-off screen** — what he wants to see when approving a proposal | Him describing it |
| **F** | **Reports** | Katie's list (0.2) |
| **G** | **Foreman Daily Log** | Writes payroll — recommend starting fresh, not extending |
| **H** | **Joint smoke test** — notifications, Field Ops clock in/out, work-order notes reaching the crew | A session with you |
| **I** | **Lead flow** — Brendan wants Qualifying out of opportunities into a lead object that converts in | Largest remaining item; you deferred it to the end |

Two smaller things carried, neither urgent: delivery-row queries could filter by
`project_id` now that the column is enforced (hardening, §1.6), and twelve date
sites that subtract real timestamps where the only error is a DST-boundary floor
(listed at the bottom, deliberately not swept).

---

## 0. BLOCKED ON YOU — nothing moves without these

| # | Item | Why it blocks |
|---|---|---|
| 0.1 | **Stephanie's findings** | You said we have them; they have not reached me. I have no content for her list — proposal page order, Submittals feedback, Letter of Transmittal specifics + signature, the large-file issue were the headings from before. Paste them and they get slotted below. |
| 0.2 | **Katie's Reports list** | Section 5 cannot start without it. |
| 0.3 | **`PPP_ADMIN_EMAILS` not set in Vercel** | Production is running on the hardcoded bootstrap admin list. Fine while it is you and Katie; set it before more logins exist. |
| 0.4 | **Brendan's sign-off screen** | Needs him to describe what he wants to see when approving. |

---

## 1. OPEN AUDIT FINDINGS — raised by the review session, not yet closed

These are against work I shipped. Ordered by consequence.

| # | Finding | State |
|---|---|---|
| 1.1 | **Archiving a WON deal archives its project**, bypassing the money guard added for un-winning. Its invoices drop out of project-scoped views. | **Judgement call, not yet acted on.** I think this is *correct*: archiving is explicit "hide this", where un-winning is a status correction. But it is exactly the money-hiding shape I fixed one branch of, so you should decide rather than inherit my read. |
| 1.2 | **Account edit page: the address toggle is mislabelled.** It now says "Same as company address" but still copies billing → site, the opposite of the create form. | **Real, mine.** Second time the edit page was missed after a create-form change — the same pattern as the data loss. |
| 1.3 | **Path bar: skipped stages render as "future", not skipped.** A deal dragged forward shows stages it never passed through as still ahead of it. Got *worse* when the ladder went from 3 stops to 6. | Real. Cosmetic but misleading. |
| 1.4 | **Path bar: a won-but-not-started job** highlights Pre-Construction as current when nothing has started. | Real, small. |
| 1.5 | **Auto-advance target label still says "Proposal"** where the stage is now called "Sent". | Real, cosmetic — appears in timeline entries. |
| 1.6 | **Delivery-row queries could filter by `project_id`** rather than `opportunity_id`, now that the column exists and is enforced. | Hardening, not a bug. |
| 1.7 | One consistency nit on the most recent commit. | Trivial. |

---

## 2. THE RECURRING PATTERN — worth its own line

Three separate times today, the same failure: **removing a field from the form
it was reported on is not removing the field.** It survived on the edit page, in
the writer, or in a second component that carried its own copy of a list.

Once it caused **data loss** — every save on the deal edit sheet wiped the
stored proposed start/end dates.

Now pinned by a test that asserts the `FormData` distinction the actions branch
on. **1.2 above is the last known instance.** Worth checking any future removal
against this specifically.

---

## 3. ASKED FOR, NOT YET BUILT

| # | Item | Notes |
|---|---|---|
| 3.1 | **Next-step buttons on the pipeline rows and the dashboard** | You asked for "more of that Start Project button". It exists on the deal page only. The logic is already shared, so this is placement, not new thinking. |
| 3.2 | **Lead flow** | Brendan wants Qualifying out of opportunities and into a separate lead object that converts in. You deferred it to the end. Largest remaining item. |

---

## 4. LATENT — documented, deliberately not built

| # | Item | The tripwire |
|---|---|---|
| 4.1 | **A project with no opportunity is invisible to every report.** All reports start from opportunities; `commercial_projects.opportunity_id` is nullable by design. Still latent — but no longer *silent*: `/api/admin/commercial-health` now carries an `orphan_projects` probe that warns the day the first one appears, with the fix in its hint. | The day direct T&M jobs without a bid become real. Job costs, geography and every P&L rollup must read projects first, or those costs vanish from company totals. |
| ~~4.2~~ | ~~**`rfp_received_at` is a TIMESTAMPTZ; the other date fields are DATE.** Both write paths treat it identically, so it is symmetric today.~~ **WRONG, AND FIXED (migration 133).** There were THREE write paths, not two, and they were not symmetric: the Opportunities create form and the inline editor both wrote a bare `"2026-08-12"` into a TIMESTAMPTZ — UTC midnight, i.e. 8pm the PREVIOUS evening in Eastern — so the deal stored the day before the one that was picked, and the "Plans received" tile read it back a day early. Only the Account forms' noon anchor was right. The same date typed on two screens produced two different stored days. Column is now DATE, history repaired by truncating in UTC (both conventions put the typed day in the UTC portion), all three paths write the bare day, pinned by tests. | — |

---

## 5. THE OLDER QUEUE — parked before this restructure

| # | Item | Waiting on |
|---|---|---|
| 5.1 | **Reports** | Katie's list (0.2) |
| 5.2 | **RFP email → auto-populate an opportunity** | Walking through real RFP emails together |
| 5.3 | **Joint smoke test** — notifications, Field Ops clock in/out, work-order notes reaching the crew | A session with you |
| 5.4 | **Foreman Daily Log** | Parked; it writes payroll, so I recommended starting it fresh rather than extending |
| 5.5 | **Katie items #3 / #8 / F2** | Her confirmation |
| 5.6 | **Letter of Transmittal — tap-to-sign** | Stephanie's spec (0.1). Warranty and work order already have it; LoT is the one document without. |

---

## 6. DONE — so nothing gets re-litigated

**The restructure**, all ten steps: the data split (migration 131), the
opportunity as the home of the whole job, two status paths, stage-aware
figures, the account as a shelf, saved views, the sidebar cut from eleven
destinations to eight, the reports audit, the dashboard.

**Brendan's entire list**: Industry gone · account compliance down to prequal ·
company address before billing with "same as company" · team roles to four ·
contacts on the account create form · probability and proposed dates removed ·
stages flattened to his ladder · estimator-assigned trigger · the opportunity
form expanded into his field order.

**Your smoke-test reports**: duplicate tools and tiles · the progress bar not
moving · "Status updated to Qualifying" · Estimating going backwards ·
status-vs-sub-status confusion · the proposal-page 404.

**Found in production and fixed**: thirteen queries silently returning nothing
— team lists, the notification fan-out, and four cron jobs — plus the migration
127 ambiguity that took the proposal page down.

---

## Recommended order

1. **0.1 Stephanie's findings** — they may change section 3, and building 3.1
   first risks reworking it.
2. **1.2** — small, real, and the last known instance of the pattern in §2.
3. **1.3 – 1.5** — one pass over the path bar, which has been edited four times
   without these being closed.
4. **3.1 next-step buttons** on rows and dashboard.
5. **1.1** — after you rule on it.
6. **3.2 lead flow**, last, as agreed.

§4 stays documented until its tripwire fires. §5 unblocks as its people reply.

---

## ⚠️ CORRECTION from the review session (2026-08-12) — this list MISSED live bugs + the post-audit classes

Verifying this "nothing missed" list against the code, several confirmed-open items are absent, and one
is mis-filed as DONE. Adding them so the list is actually complete:

### 🔴 §1.0 — MIG-127 EMBED IS *NOT* DONE: 7 sites still ambiguous, incl. a LIVE per-account bug
§6 marks "the migration 127 ambiguity" done, but 070f78b fixed only 3 detail-page queries. **7 more still
use `commercial_opportunities!inner(...)` with NO fkey hint** and return PGRST201. **PROVEN against prod:**
the un-named embed returns HTTP 300 / PGRST201; the named one returns 200. So RIGHT NOW:
- **Account 360 → Proposals tab shows ZERO proposals for EVERY account** (`accounts/[id]/page.tsx:4213`) — LIVE.
- **bulk-delete draft proposals errors 100%** (`proposals/db.ts:1661`).
- **proposal_idle cron never fires** (`cron/custom-notification-rules.ts:206`).
- also `competitors.ts:399`, `win-loss/reports.ts:323`, `cron/overdue-tasks.ts:57`, `proposals/page.tsx:250`.
Same one-line fix as 070f78b (add `!commercial_proposals_opportunity_id_fkey`). This is the review session's
original post-audit #1 — it was flagged, partially swept, then mis-marked done. **Second live prod bug of the
silent-empty class.**

### Also confirmed-open, absent from this list (all in `docs/POST_AUDIT_PUNCHLIST_2026_08.md`):
- **Margin basis (D2):** stage-KPI strip is fed contract-based `grossMarginPct` (`opportunities/[id]/page.tsx:1542`)
  while Costs tab / dashboard / reports use billed-based → same deal shows two margins a tab-click apart. HIGH.
- **Bare-DATE timezone cluster:** `proposal_due_at`/`follow_up_at` through `etDateOf` (a proposal due today
  reads "1 day overdue"), the list Hot filter + dashboard `relativeLabel` raw `getTime()`, `fmtEtDate` on
  work-order/field-ops DATE columns. §4.2 names only the rfp_received_at sub-part.
- **Mobile 24px touch targets:** inline-field pencil, stage-KPI parent links, saved-view chip remove-X,
  activity "Add task" — all < 44px.
- ~~**§7 completeness:** billing-stage "retainage held" tile + closed-stage "warranty expiry" tile unbuilt.~~ **DONE** — both shipped. Retainage reads through `retainageHeldForOpportunity` (`computeG702`, the same math as the printed G702 and the Projects list) so the deal page, the list and the GC's PDF can't disagree.
- **Step-7:** opportunities-LIST delivery rows show bid, not contract (`dealValueCents`).
The full 47-item punch list with file:line + fixes is in `POST_AUDIT_PUNCHLIST_2026_08.md` — fold it in so
"one list" is truly one list.

### ✅ RESOLVED (`25979c7`) — the 7 remaining mig-127 embeds now named
The other pass fixed all 7 within minutes of the finding, verified each against prod (4 were 300, 3 were
200), and acknowledged the mis-marking. Confirmed: grep for un-named `commercial_opportunities!inner` across
commercial code = **empty** (all 10 now carry `!commercial_proposals_opportunity_id_fkey`). The FK already
exists in prod (it's a query-side fix, no migration), so the Account 360 Proposals tab / bulk-delete /
proposal_idle cron resolve as soon as `25979c7` DEPLOYS (Vercel). The rest of the CORRECTION section above
(margin-D2, bare-DATE, mobile, §7, step-7) is still open and now carried in the list.

---

## VERIFY — `a576f4d` (items 2/3/4). Headlines fixed; items 2 + 3 left their TAILS.
- ✅ **Item 2 (strip):** stage-KPI now fed `dealMargin` (billed-based, D2) with a "Margin so far" label while part-billed. Correct.
- ✅ **Item 4:** `dealValueCents` prefers `accepted_contract_cents` once won → delivery rows priced at the contract, not the bid. Correct. (Minor: list total uses contract-without-COs while the dashboard tile is contract+COs — they can still differ by the CO amount; secondary.)
- ✅ **Item 3 (etDateOf root):** a date-only string is now returned untouched → the stage-KPI proposal-due/follow-up "1 day overdue" is fixed, and every `etDateOf` caller heals.

### 🟠 STILL OPEN — item 3's date cluster was NOT fully swept (the plan item names these explicitly)
"Fixed at the root, every caller heals" is true only for `etDateOf`. These siblings don't call it and are untouched:
- **Hot filter** `opportunities/page.tsx:639`: `Math.ceil((new Date(o.proposal_due_at).getTime() - Date.now())/MS_PER_DAY)` — raw getTime, a proposal due today still drops out of Hot after ~8pm ET. `daysFromTodayEt` is already imported (line 97) but not applied here.
- **Dashboard `relativeLabel`** `page.tsx:69`: `daysBetween(iso, new Date().toISOString())` — raw getTime → "Due today" still flips to "Due yesterday" in the ET evening.
- **`fmtEtDate`** `invoices/format.ts:63`: still `new Date(iso)` with NO bare-date guard → work-order `scheduled_*` + field-ops `work_date` (DATE cols) still render a day early. Add the same date-only guard `etDateOf` just got.

### 🟠 STILL OPEN — item 2's report CAPTIONS still say contract-based (the same-page contradiction)
- `reports/job-costs/page.tsx:73`: "Margin = contract − cost (the projected profit…)" — now contradicts the billed-based code AND the Costs tab it claims to match.
- `reports/geography/page.tsx:95`: "Margin is contract-based." — flatly wrong; code is `marginFrom(billed, cost)`.
Change both captions to "billed − cost" so the label matches the number.

---

## VERIFY — `5daf83b` (item 3 tail + items 2-caption/5/6/7 ride-along). Mostly complete; 2 tails.
✅ **Item 3 date cluster COMPLETE:** Hot filter → `daysFromTodayEt`, dashboard `relativeLabel` → `etDateOf`,
`fmtEtDate` bare-date guard (fixes the VISIBLE invoice-dated-a-day-early bug). Tests added.
✅ **Item 5:** account edit-page toggle now copies site→billing (billing mirrors company), matching create + the label.
✅ **Item 7:** tap targets hit 44px on mobile (pencil `h-11 w-11 sm:h-6`, chip `h-11 sm:h-7`, min-h-[44px] on menu/×).
✅ **Label:** `auto-advance-targets:66` now `"Sent"` (my round-1 miss #2 CLOSED). ✅ **Won-not-started** fixed (`notStarted`).
✅ **Geography caption** corrected to billed-based.

### 🟠 Tail 1 — `job-costs/page.tsx:73` header STILL says "Margin = contract − cost"
Lines 102 (tile sub) + 178 (footer) were corrected to "billed − cost", but the HEADER caption (73) still says
"Margin = contract − cost (the projected profit, same as each deal's Costs tab)" — now contradicting its own
page AND the billed-based Costs tab. Fix line 73 too.

### 🟠 Tail 2 — path-bar skipped-detection is PARTIAL (only "won" skipped, not the general sales-jump)
`stateFor` returns "skipped" only when the caller's `skipped[]` contains the key, but `StatusPathBar` computes
that set HEURISTICALLY: `skipped={inDelivery && !decided && !hasWinDate ? ["won"] : []}` — it only ever marks
"Closed Won" skipped. The commit's own goal ("a deal that jumped stages showed every stage behind it as
completed") is NOT met for the sales ladder: a deal moved straight to Sent still shows RFP/Estimating/
Pending-Approval as green-check "passed". The real reached-set is ALREADY fetched at `page.tsx:5156`
(`listOpportunityStatusLog`) for the history display — thread its visited `to_status` set into the path bar's
`skipped` prop to actually close it. (won-not-started half IS fixed; this is the skipped half.)

---

## ✅ VERIFY — `1a2103d` (item 8: retainage + warranty tiles). Complete.
Both verified: retainage renders in the billing AND closed phases (was in NEITHER money tile before — a job
holding 5% read "Collected" and looked done), computed via the shared `computeG702` (no new copy — the
one-number-one-source lesson applied), sub = "% of contract". Warranty tile in the closed phase, counted in
months, tone only in the last 60 days, "Expired" neutral. Both fetches phase-gated (retainage: billing||closed,
warranty: closed) + `.catch()` degrade. No findings. §7 gaps CLOSED.

## 🔔 STILL OPEN — tracking my two 5daf83b tails until they get a fix (not just handed off):
1. **`job-costs/page.tsx:73`** header caption STILL "Margin = contract − cost" while :102/:178 say "billed − cost" — same-page contradiction.
2. **Path-bar skipped-detection** still heuristic (`skipped={inDelivery && !decided && !hasWinDate ? ["won"] : []}`) — only "Closed Won" skipped; a deal moved straight to Sent still shows RFP/Estimating/Pending-Approval as "passed". Thread the reached-set from `page.tsx:5156` status log.
Neither touched by `1a2103d`. Re-surfacing so they close, not linger.


## Date-math sweep — what was fixed and what deliberately was not (2026-08-12)

Two different bugs live behind the same-looking code, and only one is worth
churning fifteen files over.

**Class A — a bare DATE parsed as UTC.** `new Date("2026-08-12")` is UTC
midnight, which is the 11th in Eastern. Every one of these was a real,
visible day-off. All fixed and pinned with tests:

- `etDateOf` (the root every DATE column flows through)
- `fmtEtDate` — printed one day early on every invoice, statement and AR row
- Hot-deals filter (`proposal_due_at`) — hid the bid due TODAY
- Dashboard `relativeLabel`
- `cron/debrief-overdue` (`decided_at`) — wrote the wrong number INTO the
  notification text a rep reads

**Class B — elapsed days from a real TIMESTAMPTZ by UTC subtraction.** These
are right except within an hour of a DST boundary, where the floor can land a
day early. Left alone, deliberately: 12 sites, each a cosmetic "3d ago" or an
idle-tint threshold, and today has already shown twice that a large scripted
sweep breaks more than it fixes. Sites, if it ever matters:
`opportunities/page.tsx` 2082 / 2320 / 2768 / 3073, `accounts/page.tsx` 214 /
275 / 716 / 1265, `accounts/[id]/page.tsx` 2520 / 3039,
`opportunities/export.ts` 90, `accounts/overview.ts` 91,
`cron/invoice-dunning.ts` 130 (invoice `due_at` IS timestamptz — checked),
`proposals/db.ts` 253.

---

## ✅ VERIFY — `3acace9` (item 9: next-step buttons on rows + dashboard). Correct + complete.
Reuses the shared `nextStep` (not re-implemented), "Mark it approved" opens THAT proposal (`listCurrentProposalByOpp`
now returns the id), dashboard calls the fuller query directly (perf-neutral). **My "no nested anchor" rule handled
explicitly:** dashboard renders `<NextStepButton>` AFTER `</Link>` (both in the `<li>`); the pipeline row puts it in
a separate `<div>` outside the row `<Link>`, with a comment. No `<a>`-in-`<a>` → the row link still fires. Edge cases
(lost/closed → no button) inherit from `nextStep`'s null.

**Bonus — 5th date-cluster site fixed here:** `debrief-overdue.ts` was doing raw `getTime()` on `decided_at` (a bare
DATE) → the "won N days ago" NOTIFICATION was a day early. Now `daysFromTodayEt`.
**Date cluster now PROVABLY swept:** I swept every remaining raw-`getTime()`/`Date.now()` site in commercial code —
the survivors all operate on TIMESTAMPTZ columns (invoice `due_at`, doc `expires_at`, clock punches, created_at/occurred_at
= real instants), NOT bare DATE. So no systematic day-early bugs remain. Item 3 CLOSED.

## 🔔 STILL OPEN (unchanged — tracking to a fix): job-costs:73 caption · path-bar skipped heuristic. Both grep-confirmed still present.

---

## NEXT: full re-audit of everything shipped today

Karan's ask, verbatim: *"add a re-audit / full walkthrough and edge-case
finding etc of everything we shipped today, heavy focus on the restructuring,
notes that Katie sent, pictures and screenshots she sent, Brendan's feedback
etc."*

Plan items 1-10 are complete. This is the next block, and it is deliberately
scoped as a WALKTHROUGH rather than another structural read — today's lesson,
stated by Karan directly, is that a structural audit passes while the flow is
broken ("recheck again because you should be catching mistakes like this").

Lanes:

1. **The restructure, walked as a user.** Create an opportunity from both entry
   points, move it RFP → Estimating → Pending Approval → Sent → Won, start the
   project, write the work order, bill it, close it out. Every screen, every
   transition, checking the status label, the progress bar, the stage KPIs and
   the next-step button agree at every step.
2. **Brendan's list, item by item**, against what actually renders now — not
   against what the commits claim.
3. **Katie's notes + her screenshots**, same treatment.
4. **Edge cases:** the empty deal, the deal with no account, the jumped-stage
   deal, the re-opened deal, the archived project holding money, the deal whose
   proposal was superseded mid-flow.
5. **Mobile pass** on every surface touched today.
6. **The recurring failure classes**, grepped platform-wide rather than
   spot-checked: one number computed two ways · a list existing in two places ·
   `formData.get` collapsing absent into empty · an anchor inside an anchor ·
   a bare DATE parsed as UTC · an embed with two candidate FKs.

---

## ✅✅ VERIFY — `c4fbd7c` CLOSES both my tracked tails. Verified.
- **job-costs:73 caption:** now billed-based (grep for "contract − cost" = 0) — the same-page contradiction gone.
- **Path-bar skipped-detection:** now the general rule, wired correctly. The render passes `statusLog={pathStatusLog}`
  (NOT the unwired-prop trap from last round), and `skippedStages` (kanban-columns:520) computes the skip from the
  log's `to_status`/`from_status` set: a stage is "skipped" only when its backing STATUS (`STATUS_BEHIND_STAGE[k]`)
  was provably never entered, and it REFUSES to conclude for sub-status-backed stages the log can't prove
  (`backing === undefined`). Honest + correct. Tests added.
Both my open tails are now CLOSED. Nothing of mine left tracking-open on the current batch.

---

## ✅ VERIFY — `45c49de` (item 10: two latent items). Complete + correct.
- **§4.2 rfp_received_at → DATE (migration 133):** verified. The history-repair `USING (rfp_received_at AT TIME
  ZONE 'UTC')::date` is the CORRECT choice — all 3 write conventions (bare-midnight ×2, noon-UTC ×1) put the typed
  day in the UTC portion, so UTC-truncate recovers the intent; Eastern-truncate would have corrupted the bare-path
  rows (the migration's own reasoning, confirmed). Idempotent (type-guarded), post-flight checks documented. All 3
  write paths now write a bare DATE (no noon-anchor — grep for `T12:00`/`.000Z` on rfp = empty). Closes my inline-rfp
  finding too.
- **§4.1 null-opp reporting:** an `orphan_projects` probe on `/api/admin/commercial-health` now WARNS the day a
  project with no opportunity appears ("costs are missing from every report", fix in the hint) — non-silent, the
  warn-don't-defer approach. Correct.

**🟡 ACTION: migration 133 must be RUN in prod** (rfp_received_at is still TIMESTAMPTZ until then; the "Plans
received" tile reads a day early for the bare-path rows). No deploy-gate risk.

## ✅ Plan items 1–10 ALL verified complete (2/6 tails also closed by c4fbd7c). Nothing of mine tracking-open.

---

## ✅ REVIEW-SESSION SIGN-OFF on the A-I plan (`d509022`)
Reviewed the A-I plan for completeness — accurate. My open items are correctly captured: **A** (run mig 133, my action item), **C** (archive-a-won-deal 1.1, correctly framed as Karan's judgment call), **§1.6** hardening carried. The "12 date sites deliberately not swept" call is SOUND: verified each subtracts a TIMESTAMPTZ (real instant), so the only error is a DST-boundary floor — NOT the systematic bare-DATE day-early bug (which is fully closed). Documented, not silent. Nothing of mine dropped. Ready for **B** (full re-audit) — I will verify its findings + catch misses as they land.

---

## 🔴 CORRECTION — the 1.1 archiving decision (`354069c`) rests on a FALSE premise. Re-decide with real facts.
The decision keeps a won deal's project archived, justified by: *"reports read opportunities, so an archived job
still counts in AR, P&L, job-costs and geography."* **Verified against code — that's wrong for 3 of the 4:**
- **job-costs** reads `listProjects` (job-costs.ts:119); **geography** reads `listProjects` (geography.ts:81);
  **dashboard P&L / production tiles** read `summarizeProduction(listProjects())` (page.tsx:40).
- `listProjects` queries `commercial_opportunities` with **`.is("archived_at", null)`** (db.ts:14). Archiving a
  won deal sets `archived_at`, so **listProjects EXCLUDES it** → its contract + costs **vanish from job-costs,
  geography, AND the dashboard P&L**. That IS the money-hiding shape.
- Only **AR is safe**: invoice queries filter `deleted_at` only (not the opp's `archived_at`), and archiving
  doesn't cascade to invoices — so an archived deal's invoices still count in AR.

**So the premise "still counts company-wide" holds only for AR.** Karan should re-decide knowing archiving a won
deal removes it from the cost/P&L/geography reports. Options: (a) accept it (archiving = hide everywhere — then
correct the rationale, it's not "money still counts"); or (b) if won/delivering deals should stay in cost reports,
`listProjects` needs to include archived rows (or the round-3 `projectHoldsAnything` guard should also block the
archived_at MIRROR on the reconcile branch — the §1.1-adjacent gap I flagged earlier). Not my call to make; my job
is that the call is made on true facts.

---

## ✅ VERIFY — probability re-audit (`304582f`): core fix CORRECT. But the sweep missed a 6th site.
The find is real and the root fix is right: `weightedPipelineCents` (db.ts:446) now weights by
`probabilityFor(status, sub_status)` — the STAGE — not the dead `probability_pct` column (`NOT NULL DEFAULT 10`,
uneditable since the field left the forms). Verified: typecheck clean, 24/24 stage-kpis tests pass, the 5 named UI
displays are gone, and the surviving "Win prob." on `reports/pipeline/page.tsx:105` is HONEST (a derived stage
rollup `weightedCents / bidCents`, both from the corrected weighted value — not the column). Probability map is
sensible (solicitation 10 → sent 65 → won 100 → lost 0).

**🟡 MISS — 6th surviving instance the sweep didn't catch: the CSV export.**
`lib/commercial/opportunities/export.ts` still emits the dead column:
- line 43: header `"Probability %"`
- line 197: `csvEscape(o.probability_pct ?? "")`
Every exported row now shows the stale/default-10 value under an authoritative "Probability %" column. This is the
build session's OWN stated pattern ("removing a field from the form it was reported on is not removing the field"),
and a CSV is arguably worse than a UI tile — it lands in a spreadsheet and gets treated as ground truth.
**Fix (pick one, consistent with the weighted-pipeline decision):** derive it —
`csvEscape(probabilityFor(o.status, o.sub_status))` (matches everything else, honest for old + new rows), OR drop
the column + header from the export. Deriving is the coherent choice. Handed to build session.

---

## ✅ VERIFY — Brendan's list re-audit (`92d7226`): both asks CORRECT. One soft survivor + dead code.
**(1) Remove Industry from accounts** — verified swept from all display sites: 8 named places gone, the account
hover-card only *types* `industry` (never renders it), the Industry filter *control* is gone from the accounts
page, and `distinctIndustries` (db.ts:147) is now uncalled. Column + data kept (recoverable). ✅
**(2) Team Roles → 4 (Sales Rep, Field Rep, Office Rep, Estimator)** — verified: `OPPORTUNITY_ASSIGNMENT_ROLES`
now aliases the single `ASSIGNMENT_ROLES` list, no picker offers a retired role, retired names still LABEL, and the
seniority map is migration-safe — `primary_pm:0 / lead_estimator:1 / estimator:1 / sales_rep:2 / field_rep:3 /
office_rep:4 / superintendent:5`, so the ★ primary lead does NOT shift on existing deals. Typecheck clean. ✅
(Harmless wrinkle: `estimator` and `lead_estimator` share rank 1 — a deal won't hold both, and either reading as ★
is conceptually "estimator." Not a bug.)

**🟡 SOFT SURVIVOR — accounts CSV export still has an "Industry" column.** `export.ts:24` (header) + `:93`
(`csvEscape(a.industry)`), reachable via the **Export CSV** button on the accounts page (`page.tsx:381`). UNLIKE
the probability CSV miss, this column holds REAL historical data, not a dead default — so it's not emitting a lie,
it's a scope question: does "remove Industry from accounts" extend to the export? If Brendan wants Industry gone
from the accounts experience entirely, drop the header + field. If the export is a data dump where historical
Industry is fine to keep, leave it. Karan's/Brendan's call — flagging, not asserting a bug.

**🧹 CLEANUP (minor):** with the filter control and `distinctIndustries` caller gone, `db.ts:102`
(`filters.industry` eq) + `db.ts:147` `distinctIndustries` + the `industry?` field on `AccountsListFilters` are now
dead code. Safe to leave, but worth a sweep-line.

---

## 🔴 HIGH — estimator-on-create trigger (`71adb16`) is UNREACHABLE from the UI it targets. Wrong condition + a test that masks it.
The commit's own rationale: *"Estimator is a field ON the create form … a deal typed in with an estimator already
picked landed in Qualifying."* True bug. But the fix does **not** fire from either create form.

**Why it can't fire.** The create inference (mutations.ts:103) keys on **`!input.status`** —
`const inferredFromEstimator = !input.status && input.estimator_user_id ? "estimating" : null`.
But **both** human create paths pre-default status to `"qualifying"` BEFORE calling the lib:
- inline New-Deal form — `accounts/[id]/page.tsx:1370` `String(formData.get("status") ?? "qualifying")` → passed at :1514
- main New-Deal sheet — `opportunities/page.tsx:316` same default → passed at :389

So `input.status` is ALWAYS the truthy string `"qualifying"` → `!input.status` is ALWAYS false → the inference is
dead. All 4 callers checked: the two forms above always send a concrete status; `opportunities/[id]:648` (duplicate)
inherits the source status; `bid-submit/route.ts:129` omits status but sets **no estimator** → inference still can't
yield estimating. **No caller in the codebase passes `status: undefined` + an estimator.** The stated bug is STILL
LIVE from both forms.

**The condition is wrong — the EDIT path it's mirroring proves it.** The edit trigger (mutations.ts:346) fires on
**`gainedEstimator && opp.status === "qualifying"`** — it keys on the deal being *at Qualifying*, NOT on status being
unset. The create fix should mirror that:
```
const explicitAdvanced = input.status && input.status !== "qualifying"; // Sent/etc. — a real decision, wins
const status: OpportunityStatus = explicitAdvanced
  ? (input.status as OpportunityStatus)
  : (input.estimator_user_id ? "estimating" : "qualifying");
```
That makes create consistent with edit: an estimator on a would-be-Qualifying deal lands in Estimating; an explicit
advanced stage still wins.

**The test masks it.** `estimator-trigger.test.ts` never calls `createCommercialOpportunity` — it re-implements the
inference as a local `infer()` (lines 19-20) and line 35 asserts `infer({status:"qualifying", estimator}) → "qualifying"`
— i.e. it codifies the broken UI behavior as expected, and stays green. Textbook "tests pass ≠ works when clicked."
The real test must call the mutation (or the action) with the SAME shape the forms send (`status:"qualifying"` +
estimator) and assert `"estimating"`. Handed to build session — do NOT close until a create from the actual form
lands in Estimating.
