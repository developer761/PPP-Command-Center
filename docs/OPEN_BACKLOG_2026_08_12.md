# Commercial Command Center — the one open list

**As of 2026-08-12, end of day.** Everything not finished, from both Claude
sessions, plus everything either of us parked over the last few days.

Nothing here is "probably fine". If an item is a judgement call rather than a
defect, it says so and gives the reasoning, so you can overrule it.

**Currently live:** migrations 126–132 applied · 433 tests · deploy green.

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
| 4.1 | **A project with no opportunity is invisible to every report.** All reports start from opportunities; `commercial_projects.opportunity_id` is nullable by design. | The day direct T&M jobs without a bid become real. Job costs, geography and every P&L rollup must read projects first, or those costs vanish from company totals. |
| 4.2 | **`rfp_received_at` is a TIMESTAMPTZ; the other date fields are DATE.** Both write paths treat it identically, so it is symmetric today. | A platform-wide date-type cleanup, not a patch. |

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
- **§7 completeness:** billing-stage "retainage held" tile + closed-stage "warranty expiry" tile unbuilt.
- **Step-7:** opportunities-LIST delivery rows show bid, not contract (`dealValueCents`).
The full 47-item punch list with file:line + fixes is in `POST_AUDIT_PUNCHLIST_2026_08.md` — fold it in so
"one list" is truly one list.
