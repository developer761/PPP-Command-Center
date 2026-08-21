# Remaining plan — Commercial CC (updated 2026-08-15, post-audit-remediation)

Supersedes the earlier 08-15 draft and `REMAINING_PLAN_2026_08_14.md`.
The 4-lens adversarial audit (**52 findings**) is **fully remediated** — all
three severity tiers shipped this session. What's left is **last night's build
order** (C.9 → C.5 punch-lists → Phase D re-audit → endgame).

**Verified this session:** `tsc` clean · 813 tests green · `npm run build` exit 0.
~24 commits on `origin/main`.

---

## ✅ 0. DONE — the 52-finding audit (all three tiers)

### 🔴 Emergencies (9) — money corruption / data loss / security
F1 won-deal re-quote no longer wipes the signed contract · F2 AIA G702/G703 foot
after a post-seed CO (+ issued certs frozen) · M1 bulk-delete releases ticked COs
· M2 Original-Contract-Sum stops double-counting COs · D8 archive drops debt not
just revenue · U1 4.5 MB upload cliff closed (submittals direct-to-storage, crew
photo shrink, form-loss guards) · FO1/FO2 no pay for marked-off/back-dated days ·
FO3/FO4 deactivated crew can't file hours, crew can't seed exclusions · D1 under-
contract jobs stay on the by-customer board.

### 🟠 High (~25)
M3/M5 row-cap under-counts paginated · M4 margin-tile basis · D2/D3/D5/D9/D17/D21
report contradictions · D4/D10/D11/D18 filter+CSV drops · D12/D20 report-tab/donut
· N6/N7/N15/N16/N19 notifications · E1 crew-email `.ok` · DOC2/DOC4 · FO5/FO6/FO7 ·
MOB cluster (date-×, saved-pill, chip-×, slide-out scroll-lock).
- ⚠️ **One not landed:** "last-row won/lost popover clipped by overflow-hidden" —
  couldn't reproduce across kanban / status-picker / proposal-drag. Needs Karan to
  point at the surface, or it's a non-surviving finding.

### 🟡 Medium (substantive)
evaluateRule surfaces query errors (no false success) · DOC7 transmittal soft-delete
guard · DOC11 contact-email dedup · DOC14 accounts-search filter preservation ·
N14 ⌘K rename/won-lost.
- **Left (lowest-value edges, not silently dropped):** >1000-row pagination on the
  overdue-tasks / expiring-docs / reconcile crons (unreachable near-term) · D6
  milestone past-due-at-noon TZ (cosmetic) · DOC17 fresh-install approver copy ·
  DOC15/12/13/18 (orphaned upload bytes, error-cause discard, undo-toast-on-fail) ·
  fiscal-year-January config note.

---

## 🔜 1. Last night's punch-lists — build order C.9 → C.10 → C.7 → C.6 → C.8 → C.5

> ⚠️ **Cross-check first.** This session's High/Medium work overlaps several
> last-night items — verify each isn't already fixed before re-doing it. Known
> overlaps to confirm: **C.7 F6** (AIA original-contract) ≈ M2/pickContractBase
> (likely done) · **C.7 F10** (due-date TZ) ≈ N6 (invoice) done / D6 (milestone)
> left · **C.6 C2** (void hard-deletes CO billing) — the single-void path already
> calls releaseTickedChangeOrders; confirm · **C.8 R1** (dealMargin billed-based)
> ≈ M4 (post-job tile done) — confirm dealMargin() itself.

- [x] **C.9 — Auto-advance follow-ups** — ✅ ALL FOUR already resolved by prior
  fixes; the audit doc predates them (verified 2026-08-15, no new code needed):
  - **A1** (won↔lost re-decision restamps `decided_at`) — DONE at
    `status.ts:331` (`toPreSaleClosed && (…|| beforeRow.sub_status !== effectiveSubStatus)`).
  - **A2** (`markProposalOutcome` 2nd unguarded writer) — DONE at
    `proposals/db.ts:967-999`: the won case routes through
    `autoAdvanceOpportunity('won', source:'auto_advance')` (engine's forward-only
    guard declines on a lost deal); the direct lost write now passes `source`.
  - **A3** (direct pre-sale→delivery jump stamps `decided_at`) — DONE at
    `status.ts:334` (`toInDelivery && !beforeRow.decided_at`).
  - **foldAutoAdvanceTargets** — WIRED into the drift reconciler
    (`proposals/db.ts:2754`), no longer dead.
  Covered by `auto-advance-engine.test.ts` + `decided-at.test.ts` (green).
- [x] **C.10 — Deal drill-in navigation** — ✅ done (2026-08-14). Swept the class:
  - change-orders / AIA / costs / work-order / closeout now render **inline** on
    the deal's Project sub-tab (prior restructure); their back arrow returns to
    the origin tab even after a save (the `from`-threading work above).
  - **proposals** — opening one from the deal already carries
    `?back=/commercial/opportunities/<id>?tab=proposals#deal-proposals`
    (`deal-proposals-section` + page.tsx:2893), honoured by the proposal page's
    "Back to Proposals". Clean.
  - **submittal detail** — returns to the deal's Submittals tool, with `from`
    carried through the detail page's opaque `?back=` (the threading work above).
  - **invoice editor** — `?from=<deal invoices tab>` already returned to the deal.
  - **invoice builder** (`/commercial/invoices/new?opp=`) — was the one real
    break-out: its back arrow hard-pointed at the global list, ejecting you from
    the deal. Now takes a validated `?from=`; the deal's two "New invoice" links
    stamp the deal invoices tab, so the arrow comes home (create already forced a
    return to the deal via `void rt`). Other origins keep the global-list default.
- [x] **C.7 — Flow + logic remainder** — ✅ done (2026-08-14). Cross-checked every
  finding against current code; all but one were already fixed by prior work:
  - **F1** (won-deal re-quote) ✅ · **F2** (AIA G702/G703 footing + frozen certs) ✅
    — the emergency-tier fixes.
  - **F3** (`decided_at` 3 ways) ✅ — status.ts:331/334 + `closed_out_at` column
    (same as C.9 A1/A3).
  - **F4** (no-bid debrief reclassified as Loss) ✅ — debrief.ts:244-252 protects
    the `no_bid` marker.
  - **F5** (void→draft keeps a payment) ✅ — status.ts:85-87 reconciles
    `paid_cents → status` on any move into draft.
  - **F6** (operator-entered AIA original-contract ignored) ✅ —
    `original_contract_is_manual` (db.ts:578) ranked top of `pickContractBaseCents`
    (constants.ts:228).
  - **F7** (drag→Proposal with unsent proposal reverts) ✅ — move-status/route.ts:154
    rejects with an explanatory message.
  - **F8** (Start-Project maze) ✅ — `nextStep` returns a "Start the job" CTA for won
    deals (attention.ts:174), rendered on dashboard/pipeline/deal status bar; debrief
    now stays on-page; not gated on debrief.
  - **F9** (lost-flip leaves the account) ✅ — routes to the account-scoped debrief
    page (`/commercial/accounts/<id>/debrief/<opp>?close=lost`, page.tsx:1404).
  - **F10** (due-date TZ) — header/badge already ET-fixed; **the milestone-segment
    `overdue` flag was the one gap** (raw instant compare vs noon-ET-anchored
    due_at) → NOW fixed to ET `daysBetween < 0` (invoices/[id]/page.tsx:731).
  - **F11** (reopened-expired banner) ✅ — dedicated `?approval=reopened_expired`
    flag + banner (proposal page:798/1661).
  - **F12** = C.10 (deal drill-in navigation) — handled above.
- [x] **C.6 — Completeness (20 gaps)** — ✅ all verified done (2026-08-14). Every
  C1–C15 item was already resolved by prior work (many overlap the 3-tier audit's
  fail-open/DOC findings under different labels). Spot-verified each:
  - **C1** proposal PDF footer threads `getOperatingCompany` (pdf.tsx renders from
    `company.*`; both callers pass it) · **C2** void wrapped in ConfirmSubmitButton
    with a "un-bills N COs" message when CO lines exist · **C3** `dealTaxPct` reads
    `account/opp.tax_exempt` (db.ts:407-425) · **C4** deal-delete confirm enumerates
    invoices/costs/WO/crew shifts · **C5** deactivate cancels future
    `commercial_assignments` + clears the clock PIN (employees.ts:250-267).
  - **C6** closeout transmittal/warranty pass `accountName` → `to_company ||
    accountName || "—"` · **C7** removePayment · **C8** team remove/update (error +
    `promotedAdmin` heads-up) · **C9** toggleActive · **C10** all five deletes
    (job/team/closeout-item/AIA-line/schedule-email) now capture the Result and
    redirect `?error=` on failure.
  - **C11** estimator snapshot falls back to the team `estimator` role
    (hydrate.ts:136-147) — the practical blank-sign-off case is covered; the rare
    *both*-empty deal still prints no estimator block + no send-warn (LOW, left) ·
    **C12** "Tax-exempt — Cert #…" surfaced on the invoice · **C13** dead
    `suggestedTaxPct/taxHit` removed · **C14** `formatCentsFull` isFinite guard ·
    **C15** `ComingSoonTab` deleted.
  No new code needed.
- [x] **C.8 — Re-audit remainder R1–R27** — ✅ all verified done (2026-08-14). Every
  finding was already fixed by prior work; spot-checked the criticals + money ones:
  - **R1** `dealMargin()` flipped to BILLED-based (`marginFrom(billedPreTaxCents,
    totalCostCents)`, financials.ts:233) with contract as a labeled "vs contract
    (budget)" line — auto-resolves **R2/R12/R17/R21/R22**.
  - **R3** board restructured to column-based / `OPEN_COLUMN_KEYS` (old
    `anyOnBoard` flood path gone) · **R4** the false-premise <10 min welcome
    suppression removed (documented at schedule-email-send.ts:484) · **R5** scope
    threaded into welcome + shift + day-of + weekly (`scopesFor`/`buildBody`) ·
    **R6** `getCrewScopeForOpp` splits inclusions from alternates (db.ts:468-469).
  - **R7** standalone deal page gated on `dealPhase` (page.tsx:4002) · **R11**
    costs-tool routes through `dealMargin` · **R13** resolved by the `closed_out_at`
    column split (decided_at keeps the win date on a delivery reopen) · **R14**
    pre-sale→Completed in WARN_TRANSITIONS (decided-at test covers it) · **R15/R23**
    one `statusPillTone` source · **R16** magic link renders per-job scope.
  - **R24** reports (job-costs/geography) now billed-based via `marginFrom` ·
    **R25** migration-126 guard on the main opportunities UPDATE (status.ts:406
    drops `status_user_set_at`/`closed_out_at` and retries) · **R26** account bid
    rollup uses `listCurrentProposalTotalByOpp` + `dealValueCents` fallback ·
    **R27** `proposalTrailsDeal` restricts the sub-tiebreak to `estimating`
    (targets.ts:220). **R19** correctly left DECLINED.
  No new code needed.
- [x] **C.5 — Consistency (27 items)** — ✅ all verified done (2026-08-14). D1–D5
  are now ANSWERED (doc bottom), and every item was already built to them:
  - **H1/M1** one win rate = won ÷ (won+lost) by `decided_at`, not debrief-gated
    (reports.ts:144, dashboard page.tsx:156-184) · **H2** billed-based margin
    headline + labeled contract line (= C.8 R1) · **H3** projects "Invoiced" tile
    now with-tax `invoicedCents` (page.tsx:84) · **H4** needs-debrief =
    `pre_sale_closed` only across count/UI/cron (D3) · **H5** deal-stage routed
    through `columnKeyForOpp` · **H6** proposal ID = shared `PROP-2026-0042(-R2)`
    via `proposalRecordId` (D4).
  - **M2** won-not-started split from "In delivery" via `dealPhase` · **M3**
    `closeout` kept visible ("awaiting close-out docs") · **M4** Recent-Activity
    uses `oppStatusDisplayLabel` (Won/Lost, not "Closed") · **M5** one name
    "Transactions" (index title + pointer strings) · **M6** proposals-tab deal
    link canonical `?tab=projects&project=` · **M7** deal-click no longer auto-pops
    the `&edit=` sheet (D5; the remaining `&edit=` uses are the edit form's own
    error-returns, correct).
  - **L2–L9** done (L6 dashboard greeting via `getOperatingCompany`, L9 AR-donut
    empty-state guard, etc.).
  No new code needed.

---

## ✅ Last night's plan COMPLETE (2026-08-14)
C.9 → C.10 → C.7 → C.6 → C.8 → C.5 all cleared. The build session had already
remediated the vast majority; this verification pass confirmed each finding
against current code and fixed the only two genuine gaps found:
- **C.10** invoice-builder back arrow (`?from=`) so "New invoice" returns to the deal.
- **C.7 F10** invoice milestone "overdue" flag → ET calendar days (was firing a day early).
Plus the two delivery-tool navigation commits (back arrow → origin, surviving saves).
All commits: tsc + 826 tests + production build clean.

## 🔬 2. Phase D — full re-audit
- [ ] Fresh persona + adversarial agents over everything A–C. Non-negotiable: this
  round's audits caught a live security leak and bugs in code written minutes
  earlier.

## 🏁 3. Endgame — road to done
- [ ] Reports suite — **blocked on Katie** (which reports).
- [ ] RFP email → auto-populate the opportunity — **walk the parsing rules with
  Karan**, not spec'd blind.
- [ ] **STOP → joint smoke test with Karan → DONE.**
- *(Parked: Foreman Daily Log — "don't need it for now".)*

---

## Pending on people (not buildable)
Reports → **Katie** · Letter-of-Transmittal specifics → **Stephanie/Brendan** ·
first+last-name sign-off → **Brendan** · Katie #3 / #8 / F2 → **Katie** · Proposal
page order → **Stephanie**.

## One pending confirmation (Karan, 30 s)
- [x] **Migration 137 (storage RLS)** — CLOSED 2026-08-21, and it did not need
  Karan. The note was right that the service-role path can't exercise the
  authenticated PUT; the way round it is to BE an authenticated user. Created a
  throwaway auth user, signed in with the anon key, minted a signed upload URL
  server-side and performed the upload as that user, then deleted both the
  object and the user:

  | bucket | result |
  |---|---|
  | `commercial-documents` (137's bucket) | upload accepted — policy present |
  | `commercial-opportunity-files` (152's) | upload accepted — policy present |
  | `commercial-account-docs` | refused on MIME, NOT RLS — the bucket carries an
    allow-list and the probe sent octet-stream |

  So RLS is correct on both browser-writable buckets, which also settles
  Stephanie's "I still can't upload in submittals": that was migration 152, and
  her note predates it.

  **Worth keeping as a technique:** "only a human in a browser can test this" was
  not true. A signed-in probe user tests the same policy path, and unlike a human
  it leaves a result you can re-run.
