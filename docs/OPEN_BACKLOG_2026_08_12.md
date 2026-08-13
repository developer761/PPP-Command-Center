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
| **1** | **Finish the smoke test with Katie.** It is finding more, and better, than my reading does — 14 real bugs in one sitting, several in code I had written the day before. | In progress |
| **2** | **Verify the revision rule end to end.** Button and route are both gated on the proposal having gone to the GC, with a banner explaining the bounce. Builds clean; never walked. Try "+ New revision" on a draft — it should bounce you back to the original, not mint an R2. | You, 1 minute |
| **3** | **Reports F3/F4 follow-ups** — none outstanding. F1–F4 all shipped. | — |
| **4** | **RFP email → auto-populate an opportunity.** The endgame feature. | A session on real RFP emails with you |
| **5** | **Foreman Daily Log.** Writes payroll, so I would start fresh rather than extend the hours code. | Nothing |
| **6** | **Stephanie's list.** Proposal page order, Submittals feedback, LoT + signature, the large-file issue. **The LoT blocks the last piece of tap-to-sign** — the transmittal is the only document still missing a signature block. | Her findings |
| **7** | **Joint smoke test of the un-watched surfaces** — notifications, Field Ops clock in/out, work-order notes reaching the crew, clock-PIN revocation, the crew magic link. Shipped 2026-08-11/12, reasoned about, never watched run. | A session with you |
| **8** | **Lead flow** — Qualifying out into a lead object that converts in. Largest remaining item. | Nothing; you deferred it to last |
| **9** | **Brendan's sign-off screen** — which screen forced "first + last". | Him, or a screenshot |
| **10** | **Katie #3 / #8 / F2** — the typo and its screen; whether the $8,000 auto-created proposal was a Proposal row or the deal's Bid estimate; whether submittals should be SENT from the platform or mark-as-Sent is enough. | Her |
| **11** | **`PPP_ADMIN_EMAILS` in Vercel.** Production runs on the hardcoded bootstrap list. | You, 2 minutes |
| **12** | **Ask Katie to retry adding an Alternate.** It froze in Save mode for her and needed a refresh — though it HAD saved. That is the exact signature of the swallowed-`NEXT_REDIRECT` bug fixed in all three autosave components today: the save succeeded, the redirect got eaten, the pill never moved. It may already be gone. Retrying on the current deploy is worth more than a second fix built on a guess. | Katie, 1 minute |

~~Two smaller things carried~~ **BOTH CLOSED 2026-08-12**, and the first was
not the hardening item it looked like:

- **`project_id` was not being written at all.** Migration 131 added it to
  eight tables, back-filled it once and enforced that it cannot DISAGREE with
  `opportunity_id` — but no insert path sets it, so every delivery row created
  after its project existed landed NULL. Switching reads to `project_id`, as
  the item proposed, would have silently dropped most rows on every job. The
  column looked enforced and was half-empty. Migration 135 adds the mirror to
  131's trigger (fill `project_id` from `opportunity_id`, as it already fills
  the reverse) and repairs the rows written since. Done in the trigger, not at
  eight call sites, so a ninth caller cannot forget.
- **The date sites are swept.** They were framed as a cosmetic DST wobble; the
  real finding was that the SAME relative-time ladder existed five times over,
  each with its own copy of the bug — so one job could read "6d ago" on one
  screen and "yesterday" on the next. One `daysAgoEt` / `relativeAgoEt` in
  `lib/date-et` now. The two genuine sub-day durations (the proposal-reuse
  window) are deliberately left as millisecond math, because they are
  durations and not calendar counts.

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

---

## ✅ VERIFY — Katie's notes: COI-off-closeout + doc signer (`6a5587f`). CLEAN, no miss.
- **Migration 134** — `ADD COLUMN IF NOT EXISTS signature_name/title` (nullable, idempotent). 🟡 must be RUN in prod.
- **COI off closeout** — dropped from the seed list, KEPT in `CLOSEOUT_ITEM_KINDS` so pre-existing packages still
  label the row (not "Other"), and `ADDABLE_CLOSEOUT_ITEM_KINDS` (coi-excluded) is wired into the actual add-picker
  at `closeout-tool.tsx:517` — verified it's the list the UI maps, not just a defined const. ✅
- **Signer block** — full data path confirmed: `db.ts` SELECT + type carry the columns, default record seeds
  "Brendan Dwyer / VP" (matches Katie's captured Form of Warranty even before Settings is touched), update uses the
  undefined-safe patch pattern, Settings → Operating company has both editable Fields, and BOTH PDFs guard
  `signature_name ? name[, title] : "Authorized signature"` — clean null fallback, title appended only when present
  (no dangling comma). ✅
- **Platform sweep** — "Authorized signature" exists only in the warranty + work-order PDFs (both now signer-aware).
  The other 3 PDFs: submittal + invoice-statement have no signature block; the proposal's "Estimator:" sign-off is a
  DIFFERENT, correct signer (per-proposal estimator, not the company) — so no inconsistency introduced. Transmittals /
  lien-waivers-we-sign-back are called out as forward-looking and don't render a company sig block today. ✅
- Typecheck clean. Nothing handed back.

---

## 🟡 VERIFY — mobile pass (`7d5c902`): strong, but one iOS-zoom survivor the scanner is BLIND to.
Ran the scanner + independent sweeps. Most of it holds up:
- **iOS-zoom inputs** — scanner says 0; my independent sweep of every `<input>`/`<textarea>` (arbitrary `text-[Npx]`
  AND named `text-xs`/`text-sm`, un-guarded) confirms **0 among inputs/textareas**. ✅
- **Tap targets** — the 2 remaining scanner hits are BOTH genuine false-positives, independently re-verified:
  `submittals/[sid]:1120` is a real `<label>` carrying `min-h-[44px]` (line 1111); `change-orders-panel:541` uses
  `seg` (line 528) which contains `min-h-[44px]`. Both clean. ✅
- **Fixed widths** — 0; the wide tables scroll in their own `overflow-x-auto`, the `sm:w-[440px]` is a full-width
  mobile sheet. Sound. ✅

**🟡 MISS — a `<select>` that zooms iOS on focus. `app/commercial/settings/teams/page.tsx:204`.**
The role picker: `className={\`${SELECT_CLS} !py-1.5 text-[12px] w-[150px]\`}`. `SELECT_CLS` correctly bases at
`text-base sm:text-sm` (16px mobile — the whole point of this pass), but the `text-[12px]` override has **no `sm:`
guard**, so on a phone it renders at 12px → iOS Safari zooms on focus and stays zoomed. This is the exact class the
commit set out to zero ("Nine inputs would zoom … Zero remain") — the claim is false for selects.
**Why the scanner can't see it:** its zoom check (`audit-mobile.cjs:68`) gates on `<input|textarea>` and **excludes
`<select>`** — yet iOS zooms on select focus too. **Fix:** `text-[12px]` → `sm:text-[12px]` (mirrors the commit's own
`text-base sm:text-[12.5px]` input fix — 16px on mobile, 12px from sm: up).

**🧹 SCANNER HARDENING (so this can't recur invisibly):** two gaps in `audit-mobile.cjs`'s zoom check —
(a) it excludes `<select>` (the live miss above); (b) it only matches arbitrary `text-[Npx]`, not named `text-xs`/
`text-sm` (no live input victims today, but latent). Extend the check to `<select>` and to the named small classes,
or the tool trains the next person to trust a green "iOS zoom: 0" that doesn't cover selects.

---

## ✅ RESOLVED — estimator-on-create re-fix (`e15c0e1`) VERIFIED. My HIGH finding is closed.
The re-fix is correct and now reachable. `stageForNewOpportunity(requested, estimator)` keys on
`status === "qualifying"` (mirrors the edit trigger), so `("qualifying", estimator) → "estimating"` — which is
exactly what both create forms feed it (`formData.get("status") ?? "qualifying"` + estimator). Explicit-advanced
stages (Sent, etc.) are not qualifying → left untouched (forward-only). The mutation calls the exported function,
and the **test now imports it** (no re-implemented copy) and asserts the corrected trap
(`("qualifying","u-1") → "estimating"`, `.not.toBe("qualifying")`), plus empty-string/forward-only edges. 5/5 pass.
Reachable from the UI now. ✅

---

## 📋 STILL-OPEN HANDOFFS (item B is closed as an ACTIVITY, but these FIXES are not yet in — tracking to closure)
Re-audit produced its findings; not every handed-off fix has landed. Open code items, most→least severe:
1. 🟡 **Probability CSV export** — `export.ts:43/197` still emits "Probability %" from the dead column
   (`304582f` swept 5 UI displays but not the export). Fix: derive via `probabilityFor` or drop the column. **OPEN.**
2. 🟡 **Mobile select-zoom** — `settings/teams/page.tsx:204` role `<select>` has unguarded `text-[12px]` → iOS zoom;
   scanner is blind to `<select>`. Fix: `sm:text-[12px]` + harden `audit-mobile.cjs` (cover select + named text-xs/sm).
   (`7d5c902` handoff.) **OPEN.**
3. 🟢 **Industry CSV export** (soft/decision) — `accounts/export.ts:24/93` still has an "Industry" column; real data,
   so a scope question for Brendan, not a bug. (`92d7226` handoff.) **OPEN — needs a decision, not a fix.**
✅ Resolved this pass: estimator-on-create (`e15c0e1`). — Review session tracking, will re-verify each when it lands.

---

## ✅ VERIFY — next-step button vs printed stage (`95d5f04`). CORRECT.
Karan: *"if I manually move a status back and forth this button stays there."* Root cause was real: the pre-sale
next-step + two warnings read ONLY the proposal, so a deal dragged to Sent still said "Send it for approval."
Fix takes the FURTHER-ALONG of the two clocks (deal stage vs proposal state). Traced every branch:
- `DEAL_STAGE_ORDER` = {qualifying, rfp, estimating, pending_approval, sent} — **exactly** the pre-sale keys
  `columnKeyForOpp` can emit (verified against kanban-columns.ts:184-226). No `rankOf === -1` edge.
- Lost/closed deals `return null` at attention.ts:177-178 BEFORE the pre-sale section, so "lost" never reaches the
  ranker. ✅
- Branch order is right: `proposalCount === 0 → "Build a proposal"` fires before the pending_approval branch (a deal
  manually moved to pending-approval with no proposal correctly says "Build a proposal", not "Mark it approved"); and
  `approved` outranks `pending_approval` (approved-but-unsent → "Send it to the GC" even on a parked deal — the stated
  exception). Warnings: "approved not sent" suppressed once `dealIsOut`, "no follow-up" now also fires on `dealIsOut`
  (fixed false negative). 41 tests pass; attention.ts clean.
- **Considered, intentional (not a bug):** dragging a deal BACKWARD (e.g. to Qualifying) while its proposal is Sent
  makes the button lead the printed stage ("Mark won or lost"). That's the forward-only / furthest-along design the
  commit reasons about — the sent proposal is the truth, the reverted stage is the lagging artifact. Flagging only so
  it's a known trade-off, not an oversight.

## ⏳ PENDING VERIFY (NOT yet committed) — an in-flight `lib/date-et.ts` refactor is in the working tree.
Uncommitted (build session, seen 2026-08-12): `lib/date-et.ts` + callers `accounts/[id]/page.tsx`, `accounts/page.tsx`,
`opportunities/page.tsx`, `accounts/overview.ts`, `opportunities/export.ts`, `date-et.test.ts`, plus new
`supabase/migrations/135_project_id_fills_itself.sql`. Mid-edit it references `daysAgoEt` / `relativeAgoEt` / `ms`
that aren't defined yet, so a transient `tsc` catches errors — **expected for WIP, NOT flagged as a defect.** When it
COMMITS I will verify ALL callers were updated (this is precisely the shape that ships with a caller or two left on the
old name → red build → blocked Vercel deploy), and that migration 135 is sound.

---

## ✅ VERIFY — carried items + date-et consolidation (`07c8b9f`). CORRECT & complete. Plus one severity correction.
The in-flight refactor I was tracking is now committed and **caller-complete**: `tsc` clean (my caller-completeness
concern closed), date-et 11/11, full commercial suite **498 passed / 1 skipped** — the 5→1 relative-time
consolidation regressed nothing. Import-mangling in `accounts/page.tsx:1` fixed (clean doc-comment now). The two
`ms`-math sites kept are genuinely durations (proposal-reuse window), not calendar counts. ✅

**Migration 135 (project_id fills itself)** — verified sound:
- Trigger handles BOTH directions: mirror fills `project_id` from `opportunity_id` when a project exists (the
  missing half), 131's `opportunity_id`-from-`project_id` preserved, disagreement still RAISES. Pre-sale rows (no
  project yet) and T&M rows (no opp) correctly stay permissive.
- Backfill is idempotent (`WHERE project_id IS NULL AND opportunity_id IS NOT NULL`), `UPDATE OF` list re-stated so
  re-running 131 can't narrow the trigger. Safe to re-run.
- Read-path safety: NO delivery-row read was switched to the (until-135) empty `project_id`. ✅

**🟠 SEVERITY CORRECTION — the project_id-read bug was NOT hypothetical. One live read already depended on it.**
The commit frames it as "switching reads to project_id WOULD have been a live bug." But `projectHoldsAnything`
(`ensure.ts:322`, called at :210) — the guard that decides *whether un-winning a deal may archive its project*,
whose whole purpose is "do not hide money" — ALREADY reads delivery tables by `.eq("project_id", …)`. With
`project_id` NULL on every delivery row created after the project existed (the common case), this guard has been
**under-reporting to FALSE** → un-winning such a deal would archive a project that actually holds invoices / change
orders / work orders, hiding that money from job-costs / geography / dashboard-P&L (the exact §1.1 money-hiding
shape). Migration 135's backfill + trigger DOES repair it — but only once RUN. **Net: 135 is not "hardening," it
closes a live money-hiding guard; run it promptly.** (Fix is correct and complete; this is a severity/urgency note,
not a gap.)

---

## ✅ RESOLVED — Industry CSV column dropped (`6de94f8`). Handoff #3 closed (verified aligned).
Karan called it: drop it. Verified the removal is CLEAN — the "Industry" header AND its `csvEscape(a.industry)` field
came out of the SAME column position, so header count = field count = **23 = 23**, every remaining column still maps
to its correct field in order (no shift — the classic CSV-removal trap avoided). The filename token
(`industry-…`, keyed off a filter the UI no longer offers) went too. Typecheck clean. ✅

**Handoff tracker update:**
1. 🟡 **Probability CSV export** (`export.ts:43/197`) — still OPEN.
2. 🟡 **Mobile select-zoom** (`teams:204` + scanner gaps) — still OPEN.
3. ✅ **Industry CSV** — RESOLVED (`6de94f8`).
   🧹 residual: `db.ts` industry dead code (`filters.industry` eq :102, `distinctIndustries` :147, the `industry?`
   filter field :75) is now fully unreachable — inert, compiles clean, but per "never defer" it's the cleanup tail on
   this item. Low priority; flagging so it isn't silently dropped.

---

## F · Reports — the decisions (Karan, 2026-08-12)

Six reports exist: AR aging, geography, job costs, pipeline, revenue, win/loss.
None of them has a PERSON in it, and nothing reads Field Ops' labour data.

**Fiscal year: January (calendar).** So the hardcoded calendar quarters in
`currentQuarterRange` are correct today. `fiscal_year_start_month` is still
seeded in `commercial_settings` and read by NOTHING, which is the same class of
trap as `project_id` — a knob that looks live and does nothing. Wire it to the
existing code path so changing it later actually works.

**Person-level reporting: yes, admins only.** Admin and Account Manager see
per-person numbers; a rep or crew member sees only their own. Named performance
data is the one thing here that could land badly, so it stays scoped.

**Build order (Karan picked all four):**

1. **Labour & payroll** — hours by job, by person, by week; crew cost against
   the job's budget. Field Ops holds all of it and no report reads it.
2. **Estimator / proposal performance** — bids sent, win rate, and average
   turnaround from RFP received to proposal sent. The "how is Kim doing"
   report, and the reason `rfp_received_at` had to be correct.
3. **Cash flow & collections** — money in by month, average days to pay, what
   is still out. AR aging with a time axis.
4. **Change orders & vendor spend** — CO volume and approval rate, and spend by
   supplier across all jobs.

---

## ✅ VERIFY — Reports F1: Labour & payroll (`9ebde92`). CLEAN, no miss.
New report (hours + cost by person / job / week). Verified the things that make a report trustworthy:
- **RBAC is server-side.** `labor/page.tsx` is a pure server component; the by-person half is gated by
  `canSeePeople = role admin|account_manager` and only conditionally RENDERED — the report is never passed to a
  client component and there is no CSV/export route, so per-person names/costs never reach a non-privileged browser.
  (Minor, non-issue: the full report is computed server-side even for non-privileged users, then discarded — data
  minimisation nit, not a leak.) ✅
- **Counts the SAME as the deal P&L** (the "worse than no report" risk): all three constraints REUSED not copied —
  `SETTLED_STATUSES` is actually APPLIED in the query (`.in("status", …)` at labor.ts:115, not just imported), the
  W-2 filter is byte-identical to labor-cost.ts (`worker_type === "w2"`), and effective-dated rates use the same
  `loadRates`/`rateOn`. ✅
- **Scale:** `paginateAll` on `commercial_time_entries` — no silent 1000-row PostgREST truncation (the class that
  undercounts payroll). ✅
- **Correct columns** (`display_name`, `name`, not `full_name`/`title`) — verified against schema, the silent-empty
  class avoided. Unrated hours carried separately with an amber "set their rate" band, not folded into $0. Week
  bucketing Mon–Sun string-math, tested incl. both 2026 DST changeovers. 4/4 tests, tsc clean. Nothing handed back.

---

## ✅ RESOLVED — money guard hardened (`3716e73`) + migrations 133/134/135 all confirmed LIVE.
The build session accepted the severity correction and fixed the guard properly. Verified:
- `projectHoldsAnything(projectId, opportunityId)` now queries by BOTH columns via PostgREST `.or()`
  (`project_id.eq.…,opportunity_id.eq.…`), one round trip per table; caller passes `oppId` (ensure.ts:210).
  UUID-only interpolation (no filter-injection risk), safe error→TRUE fallback kept. So the guard no longer depends
  on `project_id` being populated — defense-in-depth, works even if 135 hadn't run. ✅
- **Prod confirmation (independent):** migration **135 LIVE** — `commercial_invoices`/`change_orders`/`work_orders`
  show **0 rows** with an opportunity_id but NULL project_id (backfill took effect, no stranded rows). Migration
  **134 LIVE** — `commercial_operating_company.signature_name/title` resolve 200. Migration **133** confirmed live
  earlier. **All three run.** ✅

### 📋 Action-item status (mine to track): migrations 133/134/135 ✅ DONE. Still open for Karan:
- 🟡 **1.1 archiving decision** — re-decide on real facts (now doubly relevant: the guard bug WAS the money-hiding it
  warns about; with the guard fixed + 135 run, archiving a money-holding project is blocked, but the *report-hiding*
  of a deliberately-archived won deal via `listProjects` filtering `archived_at` still stands as the open call).
- 🟡 **`PPP_ADMIN_EMAILS`** not set in Vercel.
### Open build-session handoffs: probability CSV export, mobile select-zoom (`teams:204`) — still not landed.

---

## ✅ VERIFY — broken buttons + send-sheet + scanner (`c64aec3`). Excellent. My handoff #2 CLOSED. One miss found.
Karan: *"Mark won or lost doesn't work… Start the job doesn't work either."* Root cause verified: the links used
`?action=change-status`, a param the page reads NOWHERE (the page reads `?to=` → `preselectTo` at page.tsx:2031).
Fix verified:
- `attention.ts` links now `?to=pre_construction#change-status` (Start) and `?tab=info#change-status` (Mark won/lost,
  deliberately no `to=` prefill so a mis-click can't book a loss as a win). `to` IS consumed (`preselectTo`/
  `preselectSub`), `#change-status` anchor added to the card. New `next-step-links.test.ts` checks DESTINATIONS
  against the page's own params (verified FAILS on the old href) — replacing the label-only test that passed on every
  version of the bug. 13/13.
- **Send-proposal sheet:** "Just mark as sent" now has a "Marking…" pending state; `useScrollLock` correctly locks
  `<main>` (the shell's real scroller, NOT `<body>`) with body fallback + cleanup, applied to all 5 overlays;
  `FIELD` class fixed `text-[13.5px]` → `text-base sm:text-[13.5px]` (was zooming iOS in the very sheet complained
  about). ✅
- **Scanner widened (3rd time) — closes BOTH my gaps:** now covers `<select>` (cites the teams miss), named
  `text-xs`/`text-sm`, and local field constants (`FIELD`) via a border+padding heuristic, with `(?<!sm:)` lookbehind
  and a `text-base` guard check. Reports 0 zoom inputs now (teams:204 fixed to `sm:text-[12px]`). Also self-found +
  fixed a 40px copy-link tap target. ✅

**Handoff tracker:**
1. 🟡 **Probability CSV export** (`export.ts:43/197`) — STILL OPEN (only remaining code handoff).
2. ✅ **Mobile select-zoom + scanner gaps** — RESOLVED (`c64aec3`): teams:204 guarded, scanner now sees select +
   named classes + local constants.

**🟡 NEW MISS — the Lost quick-flip redirect wasn't swept.** `app/commercial/opportunities/page.tsx:274`:
`redirect(...?action=change-status&to=pre_sale_closed&to_sub=lost)` — the pipeline's "flip to Lost" path. It
FUNCTIONALLY works (the `to=`/`to_sub=` params are read → card pre-fills Lost), but it's the 3rd navigation path to
the change-status card and the ONLY one the sweep missed: it still carries the now-dead `action=change-status` param
AND lacks the `#change-status` anchor, so flipping a card to Lost lands the user at the TOP of a long deal page to
hunt for the pre-filled reason form — the exact "arrives at the top, looks unchanged" papercut this commit fixed for
the other two. **Fix (mirror attention.ts:155):**
`redirect(\`/commercial/opportunities/${opp_id}?tab=info&to=pre_sale_closed&to_sub=lost#change-status\`)`. Handed off.

---

## ✅ VERIFY — platform button/form recheck (`9b6aa8b`). Sound. But my Lost-flip miss is STILL open + a deferral to surface.
Three classes swept. Verified the deliverable: `SubmitButton` (`submit-button.tsx`) is a correct `"use client"` leaf
using `useFormStatus` (rightly its own component — the hook reports on the form ABOVE it), applied to the daily paths
(status card, inline field, 3 quick-flips, send-sheet). tsc clean, 514 tests pass. Dead-link sweep (212 files → 0)
and the param-read sweep are reasonable. ✅

**🟡 STILL OPEN — my `page.tsx:275` Lost-flip miss was NOT picked up (2nd commit running).** The recheck claims
"every link param is read by its destination — clean, one hit and it was fine." But `opportunities/page.tsx:275`
STILL emits `redirect(...?action=change-status&to=pre_sale_closed&to_sub=lost)` — the dead param + no `#change-status`
anchor. It sits in the checker's OWN admitted blind spot: *"my checker doesn't follow redirects"* — and this is a
server-side `redirect()`, not a Link href, so the "clean" claim structurally never covered it. Still a live
navigation papercut (flip-to-Lost lands at the top of a long page). **Fix unchanged:**
`?tab=info&to=pre_sale_closed&to_sub=lost#change-status`. Also worth hardening the param-checker to scan `redirect()`
string literals, not just hrefs — that's the class this lives in.

**🟠 SURFACE TO KARAN — 96 forms deferred, against the "never defer" rule.** The sweep applied `SubmitButton` to the
daily paths (101 → 96) and DEFERRED 96 Settings forms to "when each area is next opened," with a stated rationale
(two scripted sweeps broke things that week) and a tracking script (`audit-pending-forms.cjs`). It's reasoned +
tracked, not silent — but it directly runs against Karan's hard rule *"never defer / do them all now."* Not my call
to adjudicate the risk trade-off; flagging so Karan decides whether the rationale holds or he wants all 101 done now.

---

## ✅ RESOLVED — Lost-flip miss fixed + a checker blind spot that hid 4 MORE bugs (`b092810`).
My `page.tsx:275` Lost-flip finding is fixed: now `?tab=info&to=pre_sale_closed&to_sub=lost#change-status` (exactly
the recommended fix); **0** `action=change-status` emitters remain platform-wide. The build session generalized it —
the param-checker had only read `href=`, so `redirect()`, `window.location.href` (kanban drag-drop) and
`router.push/replace` were all invisible; it reported ZERO while 4 live sites carried the dead param. Checker now
covers all four paths (`scripts/audit-link-params.cjs`), and widening it surfaced **4 more unread-param bugs**, all
verified fixed:
- **`debrief_warn`** (the serious one) — a debrief that FAILED to save carried its error in a param nobody read: the
  status moved, the note was lost, silence. Now READ + rendered page-level at `[id]/page.tsx:1966`. ✅
- **`deal_created` / `unarchived`** — silent success confirmations, now rendered. ✅
- **`archived`** on the accounts list (no banner slot) — fallback now lands on the archive view where the row itself
  is the confirmation. ✅
Page-level render (not inside a tab) is correct — each arrives on whichever tab its action chose. 514 tests, tsc clean.

**Handoff tracker — down to ONE:**
1. 🟡 **Probability CSV export** (`export.ts:43/197`) — the only remaining open code handoff.
2. ✅ Lost-flip navigation — RESOLVED (`b092810`).
3. ✅ Mobile select-zoom + scanner — RESOLVED (`c64aec3`).

---

## ✅ VERIFY — Reports F2: Estimator performance (`87a6447`). Excellent. One latent consistency gap.
Verified against all lanes (review session now holding to Karan's "perfect" bar + the 4 SF screenshots):
- **KPI correctness** — one bid per DEAL (folds proposal revisions to earliest send), period = when the bid WENT OUT,
  turnaround excludes null RFP AND negative (sent-before-RFP typo, surfaced not absorbed, line 234), win rate =
  decided-only → "—" not 0% when nothing decided, thin-sample (`decided < 3`) flagged so nobody quotes 100% off one.
  Outcome via `columnKeyForOpp` (shared mapper — self-caught the same-deal-two-answers sin). ✅
- **Scale** — both proposals + opps queries use `paginateAll` (no 1000-row undercount). ✅
- **RBAC** — server-gated (`role admin|account_manager` redirect, estimator/page.tsx:91) AND the index card is
  render-gated (`canSeePeople ? [card] : []`, reports/page.tsx:130) — no offer-then-bounce. ✅
- **Self-caught the dead-param class** — the row link's `?estimator=` is now actually READ by the pipeline
  (page.tsx:473/666), so "show me Kim's bids" works. ✅
- **`fiscal_year_start_month` wired** (was seeded, read by nothing) — the standalone report reads + clamps it (1–12)
  and passes to `rangeFor`, so setting it actually moves boundaries. Matches the SF "Opportunity Pipeline Manager"
  report shape (grouped per-person, win rate, subtotals). 14 tests, tsc clean, mobile clean. ✅

**🟡 LATENT CONSISTENCY GAP — the fiscal setting is only HALF-wired.** The standalone report respects
`fiscal_year_start_month`, but the **index card** hardcodes January: `estimatorRange = { fromYmd: \`${estYearLabel}-01-01\` }`
(reports/page.tsx:58). Today both are January (Tomco's FY), so they agree — but change the setting and the card
summarises Jan–today while the report it links to shows the fiscal year: the exact "knob that looks live but a second
surface ignores it" shape this commit set out to kill (the fiscal knob was dead; now it's dead on ONE of two
surfaces). **Fix:** have the card read `fiscal_year_start_month` too (or share a `fiscalYearRange(today, fyStart)`
helper between card and report). Low severity (dormant while FY=Jan), but flagged for the "perfect" bar. Handed off.

---

## 🔎 REVIEW-SESSION RECONCILIATION of §1 OPEN AUDIT FINDINGS (2026-08-13) — the table above is STALE.
Checked each against current code so the baseline is accurate as Karan's session starts:
- **1.1** — SETTLED by Karan ("use best judgement") AND the money-guard branch is fixed (`3716e73` + mig 135 live).
  The report-hiding-of-a-deliberately-archived-won-deal remains a policy choice he accepted. **CLOSED.**
- **1.2** (address toggle backwards) — **FIXED.** `accounts/[id]/edit/page.tsx:271-309`: page reordered (Company →
  Billing) and the toggle now copies Company→Billing correctly, with an audit comment documenting exactly this fix.
- **1.3** (skipped stages render as future) — **FIXED.** `status-path-bar.tsx` has a real `skipped` StageState
  (line 47/86/125) rendering a "skipped" chip, distinct from future. `skippedStages` wired.
- **1.4** (won-not-started highlights Pre-Construction) — **LIKELY FINE / low-pri.** Path bar reworked; a won deal
  awaiting mobilisation genuinely sits AT pre-construction, so highlighting it reads as correct. Flagging for a visual
  confirm only, not asserting a bug.
- **1.5** ("Proposal" label where the stage is "Sent") — **POSSIBLY STILL OPEN.** `constants.ts:182` still maps
  status `proposal → "Proposal"`, and `opportunityStatusLabel` (used in timeline/move-error text, status.ts:221)
  emits "Proposal" while the board column for that status is "Sent" (`columnKeyForOpp`). So a timeline entry can say
  "moved to Proposal" for a deal shown in the "Sent" column — the dual-naming the finding described. Cosmetic; worth
  a decision: rename the status label to "Sent", or have the timeline use the column label.
- **1.6** (project_id hardening) — **DONE** via migration 135 (trigger fills it + backfill), guard reads both columns.
- **1.7** (trivial nit) — n/a.
**Net: 1.1/1.2/1.3/1.6 closed; 1.4 likely-fine; only 1.5 (cosmetic dual-naming) still worth action.**

---

## ✅ RESOLVED — plan item 2 / handoff: ALL 103 pending-state forms done (`b008e27`). Smoke-tested clean.
Karan's directive (do ALL, not incremental) is satisfied and I smoke-tested the batch as promised:
- **Complete:** `scripts/audit-pending-forms.cjs` now reports **0** forms with no pending affordance. Not incremental.
- **Safe:** independent tsc clean + 534 tests green; imports across all 25 touched files are clean (the AST
  ImportDeclaration-end fix held — no repeat of the multi-line-import mangling that broke the first attempt).
- **No client button mis-converted:** `SubmitButton` has no `onClick` prop, so the AST transform refused every
  client-handler button and touched only real `type="submit"` submits (verified: 0 conversions adjacent to onClick).
- **Multi-action forms preserved:** SubmitButton carries `name`/`value`/`formAction`; spot-checked the deal page +
  aia-line-row "Remove line" — attributes intact, JSX balanced (tsc would have caught otherwise).
Method matched Karan's ask (AST-driven, not a blind regex sweep). **Plan item 2 CLOSED.**

---

## 🟠 VERIFY — Reports F3: Cash flow & collections (`48d63a7`). Mostly excellent — ONE confirmed tax-basis bug.
Verified clean: keyed on `paid_at` via `etDateOf` (bare-date-safe), amount-weighted days-to-pay with the RIGHT
divisor (`lagWeighted / lagAmount` = Σ(days×amt)÷Σ(amt), not count), clamp-to-0 for pre-issue deposits, voids
excluded (`.neq("status","void")` + skip payments on missing invoices), both queries paginated, RBAC reasoning sound
(company money → not gated), mobile clean, 10 tests + tsc green. Cross-links to AR aging both ways. ✅

**🟠 CONFIRMED BUG — collection rate + the billed-vs-collected chart mix TWO tax bases.**
Commercial invoices carry tax (`subtotal_cents` pre-tax · `tax_pct` · `total_cents` = subtotal+tax · `balance_cents`
= total−paid). So payments (`amount_cents`, summing to `paid_cents`) are on the **tax-INCLUSIVE total** basis. But:
- `collected` = Σ payment `amount_cents` (tax-inclusive) — cash-flow.ts:177-179.
- `billed` = Σ `subtotal_cents` (PRE-tax) — cash-flow.ts:224.
- `collectionRatePct = collected / billed` (line 263) → **systematically inflated by the tax rate**: a fully-
  collected month reads ~108% at 8% tax, not 100%. The commit attributes >100% to "older invoices landing in the
  window," but the DOMINANT driver is the tax-basis mismatch — even with zero timing effect it exceeds 100%.
- The **chart** plots pre-tax billed vs tax-inclusive collected side by side; the collected bar sits ~tax% above
  billed for the SAME money, so "the gap is the story" is distorted — perfect same-period collection looks like
  over-collecting.
A cash-collection ratio/chart must be same-basis. **Fix:** for the collection rate + the chart's billed line, use
`total_cents` (tax-inclusive, to match the cash actually received) — OR net tax out of `collected`
(amount × subtotal/total per invoice). The "pre-tax billed" convention is fine for a REVENUE trend, but this report
cross-compares against real cash, so the two sides must match. Magnitude scales with how many invoices carry
`tax_pct > 0` (tax-exempt GCs = no effect), but it's structurally wrong for any taxed invoice — and it's a number
Alex reads. Handed off.

---

## ✅ VERIFY — Reports F4: Change orders & vendor spend (`77981b2`). CLEAN, no miss. (Reports F1–F4 complete.)
- **Unbilled CO headline correct** — `approved && !invoiced_invoice_id && amount > 0` (line 232), i.e. approved +
  uninvoiced + ADDITIVE only. The `invoiced_invoice_id IS NULL` signal is a direct, correct "not yet billed" test.
- **Adds/deducts never netted** (signed `amount_cents` split into approvedAdd/approvedDeduct), **approval rate excludes
  pending** (approved ÷ (approved+declined), null when nothing decided) — same honesty as the estimator win rate.
- **Vendor grouping** conservative (`vendorKey` normalises case/punct/suffix, won't merge "Sherwin" into "Sherwin
  Williams", "---" → Unattributed, says when a row combined variants). ✅
- **Vendor spend = Σ `amount_cents`** — NOT a ratio, so no F3-style tax-basis bug. Purchases table (mig 095) has no
  planned/draft status, so all non-deleted rows are actual spend; job-costs reads the same `deleted_at IS NULL`
  universe → the two reconcile. ✅
- Pagination on all three queries, RBAC behind commercial access (company money, consistent with F3), mobile clean
  (the `change-orders-panel:541` scanner hit is the pre-verified `seg`-const false-positive). 9 tests, tsc clean.

**Reports F1–F4 all shipped + verified. Net across the four: only the F3 collection-rate/chart tax-basis bug is open.**

### ⏳ STILL OPEN from this session (review-session tracking):
- 🟠 **F3 collection-rate + chart tax-basis** (`48d63a7`) — collected is tax-inclusive, billed is pre-tax; ratio + chart
  inflated by tax rate. Fix handed off; build session went F3→F4 without picking it up. **Track to closure.**
- 🟡 **F2 index-card fiscal half-wiring** (`87a6447`) — card hardcodes January while the report respects the setting.
- 🟡 **Probability CSV export** (older handoff) — still emits the dead column.
- 🔵 **1.5** — "Proposal" status label vs "Sent" column (cosmetic).

---

## ✅ VERIFY — buttons (3rd attempt) + submittals-first delivery order (`fd59ab9`). CORRECT & robust. Lost-flip now bulletproof.
Karan: buttons "still did nothing" + "submittals is before they start the job." Both fixed properly:
- **Buttons — root cause finally nailed:** a `#hash` alone does NOT scroll after a SOFT (client) navigation, so the
  card rendered but off-screen — looked dead twice. Fix removes scroll dependence entirely: `focus=status` param →
  the Overview tab renders the ChangeStatusCard FIRST, ringed (`ring-2 ring-cc-brand-400`, [id]/page.tsx:3075), with
  the hash kept as a hard-load fallback. Page reads `sp.focus === "status"` (line 2076). Traced end-to-end, and the
  destination test flagged `focus` as unread until it was wired. **My tracked Lost-flip finding is now bulletproof** —
  the redirect (page.tsx:280) carries `focus=status` too, so it no longer depends on the hash I'd recommended. ✅
- **Delivery order** — now submittals → work order → in progress, each pre-picking its stage. Two correctness guards
  verified: (1) the signal is "no submittals EXIST" (`submittalCount === 0`, attention.ts:175) — an OPEN submittal is
  normal (sitting with the GC), so it won't loop; (2) `=== 0`, never `?? 0` — an unloaded `undefined` (pipeline list)
  falls through to "Write the work order" instead of telling every won job to send submittals. And submittals now LOAD
  at pre_construction (`pathNeedsSubmittals = in_progress || pre_construction`, page.tsx:1484 → count at :1568) — the
  commit caught that they were fetched only for in_progress, so the step would have shipped dead. ✅
64 tests, tsc clean. No miss — buttons genuinely work now (verified render-order, not just compile).

---

## ✅ VERIFY — delivery-tools checklist on the deal (`2f68d83`). CLEAN. One light observation.
Karan: "we're in delivery and there's no work order/closeout/warranty here." Fixed with a page-level state CHECKLIST
(not a nav row), visible from any tab (page.tsx:2074, above tab content), ordered by workflow.
- **Honesty verified (the commit's own stated risk):** every strip state reads REAL fetched data —
  `listOpportunitySubmittals` (page.tsx:1486) and `listCloseoutPackages` (1491) now load for ANY won/delivering deal,
  not just specific stages, so the strip can't report "Not sent/Not started" it never checked. Submittals state
  correctly splits "N awaiting the GC" (active) vs "N closed" (done) — an open submittal is the normal state, not
  unfinished. Work order / change orders / billing / costs / closeout all read their real arrays. ✅
- Mobile clean, tsc clean, suite green.
- **Two NOT-built items documented, not silently left** — (a) crew clock-in → auto-advance to In Progress
  (deliberately off the auto-advance whitelist that an adversarial pass hardened — a business call), (b) "no project
  record" is a workaround-instruction not an action (needs a real button, not render-time row creation). Both
  correctly scoped out with rationale.

**🔵 LIGHT OBSERVATION (not a miss):** Karan named "warranty" explicitly, but the strip folds it into the **closeout**
row rather than showing it as its own state. The data already exists (`pathWarrantyThrough`, page.tsx:1501). If Karan
wants at-a-glance warranty status ("active through <date>") as its own checklist row, it's a ~small add. Flagging so
it's his call, not silently decided.

---

## ✅ VERIFY — tabs vanishing + team-roles DB + billing completeness (`e353b64`). All fixes correct. 🔴 TWO of my OWN misses surfaced here.
Fixes verified:
- **Tabs vanishing** — `isOppWon` (page.tsx:1802) now uses the SAME `isWon || isDeliveryPhase` predicate as the strip
  (1478), so Project/Invoices tabs stay + the strip's links resolve across all delivery phases. ✅
- **Migration 136** — widens BOTH role CHECK constraints (account + opportunity) to Brendan's four + all retired
  roles, idempotent (`DROP IF EXISTS`), coupling comment + post-flight checks. A new test
  (`assignment-roles-vs-db.test.ts`) reads the CHECK out of the migrations and asserts every app-writable role is in
  it. 🟡 must be RUN — team roles stay broken until it lands. ✅
- **Billing completeness** — `contractCents = base + netApprovedChangeOrderCents` (financials.ts:78), so "Left to
  bill" is contract-TO-DATE and an approved CO reopens a 100% job; over-billing is NAMED not netted; retainage now
  loads for any won deal (was only Billing) so "Paid in full" can't show over held retainage. Both sides pre-tax → no
  F3-style basis bug. 571 tests, tsc clean. ✅

## 🔴 REVIEW-SESSION SELF-CORRECTION — I passed two commits that carried LIVE bugs. Owning them + tightening my lanes.
1. **Role CHECK constraint (shipped in `92d7226`, which I VERIFIED "correct").** I checked the app-side role list +
   seniority + `tsc clean` and closed it. I did NOT check the Postgres CHECK constraint, which still listed the old 7
   roles — so field_rep/office_rep/estimator were rejected on submit with a raw error: **team members could not be
   added, in production, from the day those roles shipped.** `tsc` gave false confidence — it cannot see a DB
   constraint. **New lane:** any app enum/list mirrored in a DB CHECK/enum → verify the constraint on every change.
2. **Strip → hidden tabs (shipped in `2f68d83`, which I VERIFIED "clean").** I checked the strip renders + honest
   states + mobile, but NOT that its tiles' links landed on VISIBLE tabs. The tabs used a narrower "won" predicate, so
   in delivery phase the strip linked to hidden tabs → "brings me nowhere." I hold the build session's buttons to
   "does the link resolve" — I failed to apply it to the strip I'd just passed. **New lane:** verifying any nav/strip
   → confirm its link targets are reachable in the SAME states, not just that the source renders.
Both are exactly the cross-surface classes I catch in others; recording them so the standard is symmetric.

---

## ✅ VERIFY — proposal/deal agreement + strip step-aside + Activity feed (`3c7a69b`). CLEAN, no miss.
- **Proposal vs deal consistency** — the proposal page's Won/Lost buttons now gate on `!dealDecided` (deal is
  pre_sale_closed OR any delivery stage), not just `proposal.status === "sent"`. So once the outcome is recorded (or
  the job is past the sale), the proposal can't invite you to re-decide. Same "two surfaces, one deal, must agree"
  rule as the path bar + next-step button. ✅
- **Strip step-aside** — hidden on Project/Invoices tabs (`primary !== "project" && primary !== "invoices"`), where
  the sub-tab row IS the nav, killing the triple-chrome. **Applied my link-reachability lane** (the one I missed on
  2f68d83): verified the SubTab type (page.tsx:1335) + sub-tab row (1359-1365) list ALL SIX strip tools — submittals,
  work-order, change-orders, aia, transactions, closeout — so nothing is stranded when the strip hides. Reachable. ✅
- **Activity feed** — added proposal lifecycle (created, sent-for-approval with wait, approved, approved-not-sent
  with age, with-the-GC with age), aged in ET calendar days via `etDateOf` + `daysFromTodayEt` (activity.ts:156-158)
  — a proposal sent last night reads "today," not two days. No bare-date bug. ✅
tsc clean, suite green. No miss.

---

## 🟠 VERIFY — Invoices-as-delivery-tool + per-deal Analytics (`a48a758`). Nav clean — but a 2ND tax-basis bug (same class as F3).
Verified clean:
- **Old `?tab=invoices` links resolve** — resolver maps `raw === "invoices"` → `{primary:"project", sub:"invoices"}`
  and it's explicitly removed from the direct-primary short-circuit list, so bells/bookmarks/notifications still land
  right (link-reachability lane applied — this is the class I missed on 2f68d83). `analytics` maps the same way. ✅
- Strip phase-grouped (Pre-Con · In Progress · Billing · Closeout), invoicing reads collected-of-invoiced + retainage
  last. tsc clean, suite green.

**🟠 CONFIRMED — the Analytics chain mixes tax bases, exactly like F3 (`48d63a7`).** `getProjectFinancials` exposes
BOTH figures on purpose (financials.ts:28-31): `invoicedCents` = Σ `total_cents` (WITH tax, "the AR figure") and
`billedPreTaxCents` = Σ `subtotal_cents` (PRE-tax, commented *"compared to the contract"*). The Analytics chain
(page.tsx:2295-2297) passes **`invoicedCents` (tax-inclusive)** and **`collectedCents` (tax-inclusive, `paid_cents`)**
but measures every bar against **`contractToDateCents` = base + netCo (PRE-tax)**. So:
- "Contract vs invoiced" (deal-analytics.tsx:77 `unbilled = contractToDate − invoicedCents`) is understated by the
  tax, and a fully-billed taxed job reads **invoiced > contract → "over-invoiced"** when it's exactly on-contract.
- Same for "contract vs collected."
**Fix is already on the shelf:** use `billedPreTaxCents` for the invoiced bar (financials LITERALLY labels it "compared
to the contract"), and a pre-tax collected figure for the collected bar (net tax from `collectedCents`, or add
`collectedPreTaxCents` to financials). The stage-KPI "Left to bill" (e353b64) already does this right
(billedPreTaxCents vs contractCents) — the analytics just reached for the wrong field.
**🧹 This is the 2nd instance of the class → SWEEP:** anywhere a tax-inclusive invoiced/collected is compared against
the pre-tax contract. (The AIA tile's collected-of-invoiced is fine — both tax-inclusive. `billedSoFar` uses
billedPreTaxCents — fine.) Handed off.

---

## ✅ VERIFY — analytics-tab + phase blocks + add-inclusion refresh (`cd901b9`). CLEAN. (Plus an uncommitted WIP note.)
- **Analytics promoted to a primary tab** on won deals (unfindable as a sub-tab). Link-reachability lane applied: old
  `?tab=analytics` links resolve via `raw === "analytics" → {primary:"analytics", sub:null}` (page.tsx:1443) and it's
  in the direct-primary list (1419). ✅
- **Add-inclusion no longer asks to leave the site / needs a manual refresh** — the action `redirect()`'d to the URL
  it was already on (a no-op in the App Router → the revalidated total never painted, and the real navigation tripped
  the autosave "Leave site?" guard). Now `revalidatePath` alone: action returns, server re-renders fresh, user stays
  put. Form-behavior lane: correct. ✅
- **Phase grouping** into bordered blocks with heading + open-count, phases DERIVED from the tools
  (`[...new Set(tools.map(t => t.phase))]`) so a new tool can't introduce a phase the strip forgets. ✅
- Deferred-with-rationale (not silently dropped): the revision-rule gate ("+ New revision" only after a proposal has
  gone to the GC) — "it is next."

**⏳ UNCOMMITTED WIP (not a defect):** the working tree has the revision-rule feature mid-edit (proposal
`[proposalId]/page.tsx` + `new/page.tsx`), referencing `sp.kept` before the searchParams type carries it → a
transient `tsc` error. NOT in cd901b9 (0 mentions of `kept`) and NOT flagged as a bug. Will verify caller-completeness
when it commits (same discipline as the date-et refactor — check before crying wolf).

---

## 🟠 VERIFY — analytics rebuild + strip revert (`fe0d958`). New visuals are strong. But my tax-basis finding is STILL NOT FIXED, and the rebuild added a 2nd instance inside the same component.
Good: strip reverted to one row (Karan's stated preference — "I like the other bar better"); the new visuals earn
their place — donut of cost composition (costs, no tax issue), margin gauge swept to 40% (dealMargin/D2,
platform-agreed), KPI cards + sparklines, and `collectedPct = collectedCents/invoicedCents` is CORRECT (both
tax-inclusive → paid/total). Billing months keyed on issued, drafts excluded. tsc clean, tests green, revision-rule
WIP committed cleanly.

**🟠 STILL OPEN + now WORSE — the tax-basis bug persists in the money chain AND a new form appeared in the monthly chart.**
The rebuild changed the visuals but not the underlying bases:
- **Money chain** (deal-analytics.tsx:57, 85-109) — unchanged from my a48a758 flag: `unbilled = contractToDateCents
  (PRE-tax) − invoicedCents (TAX-INCL)`, and both invoiced + collected bars (tax-incl) are measured against the
  pre-tax contract. A fully-billed taxed job still reads "over-invoiced." NOT FIXED.
- **NEW — the billing-over-time chart mixes bases internally** (page.tsx:1610-1611 → deal-analytics.tsx:223-224):
  monthly `invoicedCents = subtotal_cents` (PRE-tax) but `collectedCents = paid_cents` (TAX-INCL). So a month's
  collected bar can exceed its invoiced bar (paid includes tax the subtotal doesn't), inverting the "widening gap =
  money going out faster than coming back" story the chart is built to tell.
- Minor: the Invoiced KPI value is tax-incl (`invoicedCents`) but its sparkline is pre-tax (monthly subtotal) — same
  number, two bases.
**Coherent fix (pre-tax throughout, since the contract is inherently pre-tax):** money-chain invoiced →
`billedPreTaxCents` (financials already provides it, labeled "compared to the contract"); collected → a pre-tax
collected figure (net tax from `paid_cents`, or add `collectedPreTaxCents` to financials); monthly collected → same
net-of-tax. Then every bar shares the contract's basis.
**This is now 3 tax-basis sites (F3 cash-flow · deal money-chain · deal monthly chart) — a systematic pattern, not
one-offs.** Re-flagged; handed off.

---

## ✅ VERIFY — swallowed redirect + Fix-link-to-nonexistent-field (`7a3a497`). CLEAN, no miss. Systematized my link-reachability class.
- **"Autosave boots us out and won't let us back in" (submittals + proposals)** — root cause: a bare `catch {}` in
  `autosave-proposal-form` swallowed the `NEXT_REDIRECT` control signal, so the action's `?error=` conflict-redirect
  never navigated and the pill stuck on "error." Fixed in all three affected forms (autosave-proposal-form,
  aia-settings-form, aia-line-row) with the correct pattern: `if (err.digest?.startsWith("NEXT_REDIRECT")) throw err`
  — re-throw the redirect, handle only genuine errors. Verified in each. Commit is honest that it didn't reproduce the
  full boot-out end-to-end, but the swallowed redirect is a real defect on exactly the named surfaces. ✅
- **"Fix buttons don't do anything"** — the follow-up warning deep-links `?ef=follow_up_at`; the field was on
  `INLINE_FIELDS` but never had a ROW on the page, so the link opened nothing. This is exactly my LINK-REACHABILITY
  class ("on the editable list ≠ rendered"). Now fixed AND systematized into a test: `next-step-links.test.ts`
  asserts every `INLINE_FIELDS` entry has an `inlineRow("<name>")` on the deal page, with exemptions named (the ones
  rendered via other controls). `follow_up_at` is NOT exempted → the passing test proves it renders. Verified it fails
  if the row is removed. ✅
tsc clean, suite green. Good to see the render-parity class I flagged now guarded by a test rather than vigilance.

---

## ✅ VERIFY — delivery tool takes the page + deal-name exit (`b621128` + `a0435f9`). CLEAN, no miss.
Karan: "too many blocks and buttons, it's overwhelming" → opening a tool should be its own page with a back arrow.
- **Tool-as-page** — `toolView = primary === "project" && !!rawSub`. When a tool is open the tab rows + strip step
  aside for a focused view; on `?tab=project` with NO sub the strip IS the tool list (renders when `!toolView`).
  Traced navigation (link-reachability lane): the two exits from a tool both land real — **back arrow** →
  `?tab=project` (tool list, where the full tab bar + strip return, so every other tab is reachable), **deal name** →
  `/opportunities/${id}` (job overview, a0435f9). Nothing stranded. Invoices (a project sub) gets the focused view
  consistently; Analytics (a primary tab) stays top-level. ✅
- tsc clean, tests green. Good IA cleanup; my link-reachability lane confirms the graph is whole.

---

## 📊 OPEN-HANDOFF STATUS CHECK (review session, 2026-08-13) — "make sure things are getting fixed."
Re-verified every outstanding handoff against LIVE code + prod:
**✅ CLOSED since last check:**
- **Probability CSV export** — FIXED: `export.ts:201` now derives `probabilityFor(o.status, o.sub_status)` (not the
  dead column). My exact recommendation.
- **Migration 136 (team roles)** — CONFIRMED LIVE in prod: an `estimator`-role insert clears the CHECK constraint
  (fails only on a dummy user FK, code 23503, not a role check-violation). Team members can be added again.
- All per-commit items across today's session verified fixed (tabs, roles-DB, billing completeness, buttons 1-2-3,
  autosave redirect, submittals-first, delivery strip, analytics visuals, tool-as-page).

**🟠 STILL OPEN — the ONE thing not landing (flagged 4×, and the analytics rebuild touched the code without fixing it):**
- **Tax-basis, 3 sites — same class:**
  1. `cash-flow.ts:225-226,263` — `billed` sums `subtotal_cents` (pre-tax); `collected` sums tax-incl payments →
     collection rate ~108% at full collection.
  2. `opportunities/[id]/page.tsx:2379` → deal-analytics money chain — tax-incl `invoicedCents`/`collectedCents`
     against pre-tax contract → "over-invoiced" on taxed jobs.
  3. deal-analytics monthly chart — pre-tax `subtotal` invoiced vs tax-incl `paid` collected → gap inverts.
  **One coherent fix:** pre-tax throughout — `billedPreTaxCents` for invoiced (already provided by financials), a
  pre-tax collected figure (net tax from `paid_cents`, or add `collectedPreTaxCents`). Numbers Alex/Karan read.

**🟡 STILL OPEN — low priority / latent:**
- **Report fiscal cards hardcode January** (`reports/page.tsx:60,77`) — estimator + CO-vendor summary cards use
  `${year}-01-01` instead of `fiscal_year_start_month`. Dormant while Tomco's FY = Jan; agrees today.

---

## 🟢 TAX-BASIS SWEEP — 2 of 3 fixed (incl. one by me), 1 handed off. + `6d972cf`/`4aeb5a0` verified.
Karan 2026-08-13: "make sure everything is getting fixed either in this session or the other one."
- ✅ **Deal money chain** — FIXED by build session (`6d972cf`): invoiced bar → `billedPreTaxCents` (pre-tax vs the
  pre-tax contract); collected bar scaled to pre-tax (`invoicedCents × collected/invoicedWithTax`) so all three bars
  share a basis; collected % uses the honest with-tax ratio, labeled "(incl. tax)". Correct. Verified.
- ✅ **F3 cash-flow rate/chart** — FIXED by ME (review session; shipped inside `4aeb5a0` after a `git add -A` swept my
  edit in): `billed` now sums `total_cents` (with-tax), so the collection rate is cash-in ÷ amount-invoiced (both
  with-tax) and the two chart lines share a basis. Same principle as the deal fix.
- 🟡 **Deal monthly-billing chart** — LAST one, still open (`page.tsx:1627-1628`): monthly `invoicedCents = subtotal`
  (pre-tax) but `collectedCents = paid` (with-tax), so a month's collected bar can exceed its invoiced bar, inverting
  the "gap = money slower than work" story. **Precise fix (match the money chain's pre-tax basis):** keep
  `invoicedCents = subtotal_cents`, change `collectedCents` to net-of-tax = `paid_cents × (subtotal_cents/total_cents)`
  (guard total>0). Needs `total_cents` on `pathInvoices` — confirm it's selected. HANDED to build session: page.tsx is
  their active file and they just did the money-chain fix, so this is one edit right next to it. (I'll take it if it's
  quiet and they haven't.)

**4aeb5a0 (status-update seam + completion guard) — VERIFIED correct:** the `post_sale_closed` guard's stated reason
was stale (decided_at keys on pre_sale_closed, not post) — corrected in place, guard kept for the TRUE reason
(close-out paperwork done ≠ job done while retainage held). Step now: closeout+moneyClear → "Mark it completed";
closeout+money-out → "Chase the last payment" (points at invoices, doesn't hide the money); either half → "Close it
out"; `=== true/false` so an unloaded signal never offers completion. Sound.

## 🔴 REVIEW-SESSION SELF-CORRECTION #3 — the voided-submittal bug was in code I passed.
`6d972cf` caught that a VOIDED submittal counted as "1 closed" and (worse) suppressed the "send submittals" step
(`submittalCount` non-zero). That strip is the one I verified "clean" in `2f68d83` — I checked the open-vs-closed
split but NOT the voided case. Third own-miss this session; the lane it belongs to (verify status enums handle
ALL values incl. void/cancelled, not just the happy split) is now noted.

---

## ✅ TAX-BASIS SWEEP CLOSED — all 3 sites fixed (2 by review session, 1 by build session).
- ✅ **F3 cash-flow** rate/chart — review session (`billed → total_cents`, shipped in `4aeb5a0`).
- ✅ **Deal money chain** — build session (`6d972cf`, invoiced → pre-tax, collected scaled/labeled).
- ✅ **Deal monthly-billing chart** — review session (`a480edf`): monthly collected now net-of-tax
  (`paid × subtotal/total`), matching the pre-tax invoiced. tsc + suite green.
No tax-basis sites remain. The systematic "with-tax figure compared against a pre-tax reference" class is swept.

---

## ✅ VERIFY — Katie's list part 1: 4 fixes (`3a299cb`). CLEAN, no miss.
- **Double "Approved" banner** — the transient `?approval=approved` toast removed; the persistent `status===approved`
  banner (which also states locked-from-editing / Unlock) kept. One state, one banner. ✓
- **"Next status" showed the current stage** — relabelled `statusLabel="Move this deal to"` (page.tsx:3869) + the
  current option now reads "… (current)" (status-sub-status-picker:284). Still no pre-pick (mis-click safety). ✓
- **Product description autofilled two lines** — `product-picker` `normalizeWs` now collapses ALL whitespace (`\s+`),
  so a catalogue entry with a stray `\n` autofills as one line. NOT a residual: checked the PDF's separate
  `normalizeWs`/`ItemLine` — its `\n`-split is DELIBERATE multi-line support, and the PDF bulleting is a separately
  tracked Katie item. Avoided a false flag by reading the render path. ✓
- **Intro help text** clarified (typing replaces the Tomco default). ✓
tsc clean, 44 test files pass. Katie's other 5 (Contact edit btn, estimator sign-off from opp team, Alternate freeze
in Save, 2 PDF items) honestly listed as still being worked.

---

## ✅ VERIFY — Katie: edit contacts (`c69d6fe`). CLEAN, no miss.
There was no contact writer at all (add/detach/set-primary only), so fixing a typo meant detach+re-add (losing history).
- `updateAccountContact` writes the PERSON (full_name/email/phone/title) on `commercial_contacts`; name required,
  `trim() || null` so empty CLEARS (a departed contact can lose their line), audit-logged with `before`. Real columns
  only. ✓
- **"Changes everywhere" claim validated against the data model** — `commercial_contacts` is the shared person, linked
  to accounts via the `commercial_account_contacts` junction, so editing the person correctly propagates to every
  account it's on. Role/default-for stay on the junction (relationship, not person). ✓
- **Good discipline (my class):** removed the Notes box from BOTH form and writer on finding `CommercialContact` has
  no `notes` (notes lives on the junction) — "a field that silently saves nothing is worse than no field." Exactly the
  render/writer-parity rule. ✓
- Action auth-gated: `getUser` + `assertCommercialAccess(user.id)`; form is a `<details>` (closed until wanted).
tsc clean, 44 test files pass.

---

## ✅ VERIFY — Foreman Daily Log (`bf51ff3`). CLEAN, no miss. Payroll-writing feature done right + my DB-parity lane is now a test.
Item 4 / R10.4 (writes payroll → security + correctness critical). Verified every guard:
- **SECURITY: employee from SESSION, never the form** — `getEmployeeForUser(user.id)`; the form carries job/date/
  hours/type but NO `employee_id`, and the writer filters by the session employee, so nobody can file time against
  anyone else. Non-employee → redirect to /commercial/crew (only real employees log). ✓
- **Lock is a real guard, not a flag** — `SETTLED = {approved, exported}`; the writer REFUSES (`ok:false`, "already
  approved — ask your scheduler") before any update, so a painter can't revise payroll after approval/export. ✓
- **24h capped, not rejected** (`Math.min(24, …)`) — warn-not-reject, because refusing on site = a day unrecorded. ✓
- **Published assignments only** (`.eq("status","published")`); scheduled hours pre-fill but never assert (confirm =
  one tap); built fresh off the read-only crew surface as flagged. ✓
- **Absence list vs Postgres CHECK constraint is TESTED** (`daily-log.test.ts:72-82` reads migration 112 and asserts
  every `ABSENCE_TYPES` value is in the CHECK) — the exact app-list-vs-DB-CHECK parity lane from my team-roles miss,
  now a durable test. ✓
- Mobile-clean (no crew/log scanner hits — the phone-at-5pm surface). tsc clean, 8/8 daily-log tests.

---

## ✅ VERIFY — browser-upload RLS + autosave-eats-typing (`8e2ce3d`, Stephanie's smoke test). CLEAN, no miss.
- **Every browser upload was failing HTTP400** since the direct-to-Storage transport shipped — the commercial buckets
  have NO RLS policies, and server paths bypass RLS under the service role, so only the browser path ever met the
  check; the client sent the publishable key so the insert ran as `anon`. Fix: client now sends the session
  `access_token` (guarded if absent), and **migration 137** grants `authenticated` INSERT on `commercial-documents`
  only. Policy well-scoped — INSERT-only, authenticated-only (never anon), ONE bucket, idempotent (`drop policy if
  exists`); the server-minted signed URL is the primary gate, RLS the second. Reasonable for an internal trusted-user
  tool. 🟡 must be RUN — uploads stay broken in prod until it lands. Upload errors now report Storage's real reason. ✓
- **Autosave "erased my typing"** — every pause revalidated the page (+2 off-screen), remounting React-keyed
  inclusion/alternate rows. Fix: background save skips `revalidatePath` (writes only), explicit save still refreshes;
  debounce 800ms→2.5s. Guarded by `autosave-revalidate-seam.test.ts` — the background flag is a bare string shared
  client↔server, so renaming either side silently restores the bug; test fails when the seam breaks. ✓
tsc clean, 608 tests / 46 files pass.

---

## ✅ VERIFY — clipped dropdowns platform-wide (`96819ea`, Stephanie). CLEAN, no miss. Textbook sweep.
Stephanie: "Exclusion dropdown cuts off, can't scroll to see options." Root cause: the CARD (`EditorSection`) had
`overflow-hidden`, so options past the card border were UNREACHABLE (not just hidden).
- **Fix + visual preserved:** `overflow-hidden` removed; rounding re-homed explicitly — header band → `rounded-t-xl`,
  left-accent bars → absolute `rounded-l-xl` span. Body is `bg-surface` = card bg, so no square-corner bleed. ✓
- **Swept the whole platform (the rule):** a new audit (`audit-clipped-popovers.cjs`) found 3 MORE of the same class
  — dashboard won/lost popover, Accounts bulk-assign, Invoices delete-all — all fixed. The audit's 3-attempt
  evolution is documented honestly (2 false-cleans: indentation-based nesting broke on multi-line JSX; it missed
  clipping one level of component indirection away — the very bug it was for). Verified by reintroducing the bug. ✓
- **Accepted hits documented with reason (no silent caps):** a drawer dropdown that scrolls with its field stays
  reachable; the complete fix is a portal in `SearchableSelect`, tracked as its own change. ✓
tsc clean, 608 tests / 46 files pass.
