# Consistency punch-list (2026-08) — make the whole platform agree

From a 6-dimension + adversarial-verify workflow over the **shipped** surfaces
(28 raw → 27 verified, 0 agent errors). Every item is code-grounded with
`file:line`. Karan's bar: **same metric = same number everywhere; one name per
thing; coherent flow; nothing reads as broken.**

Ownership: the **build session** fixes these. The verification session found +
wrote them and will recheck. Grouped so nothing collides with the in-flight
Overview/auto-advance/Closed work.

> Dedupe note: a few tooltip/`$0`-vs-`—`/won-not-started items overlap the
> `OVERVIEW_AUTOADVANCE_CLOSED` spec. Those are marked **[covered by Overview spec]** —
> fix them THERE, once, not twice.

---

## 🔴 HIGH — contradictory numbers / dead-ends

### H1. "Win rate" is two different numbers the user taps between
Dashboard `monthWinPct` = won-in-month ÷ decided-in-month by `decided_at` (`page.tsx:140-147`), links straight to the Win-Loss report whose rate = won ÷ (won+lost) **debrief rows** by `debriefed_at`, scoped to the **quarter** (`win-loss/reports.ts:142-214`). Different numerator source, date field, and period — and debrief-gating means every not-yet-debriefed win (the ones the dashboard flags as "awaiting debrief") is IN the tile but OUT of the report.
**Fix:** one shared win-rate helper over opportunity decided-state (`isWon`/`isLost` by `decided_at`), same period, on both surfaces — or relabel each with its scope and point the tile at a report on the same basis. **Needs a decision (see D1).**

### H2. "Margin" shown on two bases, same screen, opposite sign + color
`(contract − costs)/contract` vs `(billed − costs)/billed`, both bare-labeled "margin." On the account deal Overview the Transactions chip is contract-based (`accounts/[id]/page.tsx:1157-1162`) while the adjacent Profitability card is billed-based (`:1422-1432`); the Costs & P&L tool stacks a contract-based tile over a billed-based gauge (`costs-tool.tsx:342-345` vs `399-403`); Job-Costs/Geography reports use contract basis (`reports/job-costs.ts:141-142`) while the dashboard project bars use billed (`page.tsx:273-281`). A $100k/$60k-cost/$50k-billed deal reads **+40% green "healthy"** and **−20% red "losing money"** side by side.
**Fix:** label the two distinctly at the headline ("Margin vs contract (budget)" vs "Margin vs billed (to date)"); never expose the contract-based `grossMarginPct` under bare "margin"; standardize reports to one basis. **Needs a decision (see D2).**

### H3. "Invoiced" = pre-tax on Projects page, with-tax everywhere else → paid > invoiced
`projects/page.tsx:67` feeds the "Invoiced" tile `billedContractCents` (Σ subtotals, **pre-tax**) but its paid sub-line and Outstanding (`:69`) are **with-tax**; the account-360 "Invoiced" tile uses `invoicedCents` (with-tax). So a taxed job shows Outstanding **greater than** Invoiced, and "paid $108,875" under "Invoiced $100,000."
**Fix (surgical):** `projects/page.tsx:67` → `activeSummary.invoicedCents` (with-tax); keep `billedContractCents` only for the pre-tax "Billed of contract" meter (`:85`). Correct the stale comment at `projects/db.ts:50-53` (`outstandingCents` = per-invoice clamped openBalance, not "invoiced − paid").

### H4. "Needs debrief" defined three ways → badge that can never reach zero
Count = `isPostSaleProject||isLost` at **any** stage (`debrief.ts:409`, dashboard `page.tsx:128,198`), but every **filing** surface accepts only `pre_sale_closed` (deal-detail tab `opportunities/[id]/page.tsx:1436`, account debrief page redirects otherwise `:116-117`, `writeDebrief` rejects non-`pre_sale_closed`), and the cron is a third narrower set. A won deal advanced into delivery is counted forever with **no UI that can clear it**; a `post_sale_closed` won deal shows a Debrief tab whose submit always errors.
**Fix:** pick ONE phase set for count + filing UI + cron. **Needs a decision (see D3).**

### H5. The pre-sale stage a deal is "in" differs by surface
Board StageChip = **5 stages** advanced by kanban column, so `(estimating, proposal_pending_approval)` highlights **Proposal** (`opportunities/page.tsx:3496-3502`). Deal-detail `DealJourneyStrip` = **4 stages** indexed by **raw status** → same tuple highlights **Estimating** (`deal-journey-strip.tsx:31-36`); the account-home pill agrees with the strip. The board's "Same structure as DealJourneyStrip" comment (`:3476`) is false.
**Fix:** route `DealJourneyStrip` + the account pill through `columnKeyForOpp` (add the RFP segment) so all three name the same stage. Delete the false comment.

### H6. Proposal record-IDs don't join the "one number follows the deal" family
OPP/WO/TRANS render the deal's shared year-root (`…2026-0042`), but proposals render `formatProposalNumber` = an **independent global** `PROP-0031` (`proposals/db.ts:99-102`). `record-ids.ts`'s `proposalRecordId` (the shared-root `PROP-2026-0042`) is **dead/unused**, and `opportunityRecordId`/`projectRecordId` duplicate other helpers. Two shipped files disagree on what a PROP id even is; `OPP-2026-0042` and `PROP-0031` sit ~20 lines apart on the invoice header.
**Fix:** pick one scheme + retire the losing helper. **Needs a decision (see D4).**

---

## 🟠 MEDIUM

### M1. `monthWinPct` uses two "won" definitions for its own num vs denom
Numerator excludes `post_sale_closed` (`wasWonInPeriod`), denominator includes it (`isPostSaleProject`) — so a job closed-out this month lands in the denominator only, deflating the rate; also disagrees with Account 360 (`overview.ts:123-129` counts `post_sale_closed` as won). **Fix (surgical):** same `post_sale_closed` treatment on both halves; align with Account 360.

### M2. "In delivery · N" counts won-not-started deals
`AccountHome` buckets `status!==post_sale_closed` as "In delivery" (`accounts/[id]/page.tsx:841,893`), but `listProjects` includes `pre_sale_closed+won` (`projects/db.ts:122`) — a just-won deal with no crew shows "In delivery" + a $0 money wall. Canonical `dealPhase` returns `won_not_started` for exactly this. **Fix:** split using `dealPhase`/`IN_DELIVERY_STATUSES` — "Won · not started" vs "In delivery." **[relates to Overview spec's WON-not-started card — coordinate.]**

### M3. `post_sale_closed·closeout` (paperwork pending) buried in collapsed "Completed"
`AccountHome` folds all `post_sale_closed` into "Completed" on top-level status only (`:907-916`), but `closeout` is still forward-progress (`stageRank`=7); only `closed` is terminal. A job actively chasing close-out docs disappears from visible work. **Fix:** keep `sub!=='closed'` visible ("Closing out"); fold only `closed`.

### M4. Dashboard Recent-Activity labels a just-won deal "Closed"
`opportunityStatusLabel` maps both closed statuses → "Closed" (`page.tsx:773,847`, `settings/archived:250,319`); every other surface uses `oppStatusDisplayLabel` → "Won"/"Lost." So the CEO's top mobile row after winning reads "Closed" (and Won/Lost are indistinguishable). **Fix (surgical, 1-line each):** swap to `oppStatusDisplayLabel(status, sub_status)`.

### M5. The cost surface has four names → broken wayfinding
"Transactions" (deal tab/card/registry), "Transactions & Job P&L" (tool header), but "Costs & P&L" (sidebar `commercial-sidebar.tsx:97`, index `post-job/costs/page.tsx:34`), and two pointer strings tell users to go to the "Costs & P&L tab" that's actually labeled "Transactions" (`page.tsx:358`, `accounts/[id]/page.tsx:2265`). **Fix (surgical):** one user-facing name (recommend "Transactions"); update sidebar + index + both pointer strings.

### M6. Proposals-tab deal link scrolls nowhere
`ProposalsTab` deal link → `?tab=deals&sub=opportunities#deal-row-` (`accounts/[id]/page.tsx:5881`), but `?tab=deals` renders AccountHome where `#deal-row-` doesn't exist → silent no-op. Every other deal link uses `?tab=opportunities#deal-row-`. **Fix (surgical):** match the canonical link (or `?tab=projects&project=`).

### M7. "Open a deal" behaves three ways
Board + AccountHome blocks open the drill-in (`?tab=projects&project=`); dashboard lists + account opp-rows use `?tab=opportunities&edit=` which **auto-pops an edit sheet** the code itself flags as disliked in 3 places; the legacy `/opportunities/[id]` bounces to the row with no edit. **Fix:** one meaning for a deal-click. **Needs a decision (see D5).**

### M8. Weighted tile's tooltip contradicts its own number **[covered by Overview spec §3a]**
Tile shows a real proposal-derived `$12.5k` but the tooltip says "No bid value set yet." and the Bid tile shows "—". Fix in the Overview spec (pass the proposal-total fallback into the tooltip + Bid display); listed here only so it's not fixed twice.

---

## 🟡 LOW (batch these)
- **L1.** Board "Bid range (open)" sums raw bid only (no proposal fallback) while Weighted + the reports pipeline use the fallback → same book, two footprints (`opportunities/page.tsx:648-650`). **[relates to Overview spec]**
- **L2.** Probability tooltip cites dead v1 statuses/percentages (`opportunities/[id]/page.tsx:1702`). **[covered by Overview spec §3a]**
- **L3.** "Win rate" also labels a per-deal proposal-acceptance ratio (`accounts/[id]/page.tsx:1627`) — rename to "Proposal acceptance" so "Win rate" means one thing.
- **L4.** Bid range formatted by `formatBidRange` (whole-k) on the deal header vs `formatCentsCompact` (one decimal) on the account → "$53k" vs "$52.5k" for one deal. Use one formatter.
- **L5.** Two status→color systems in the account page (`PipelineDealBlock` vs `statusPillTone`) — proposal is red one place, blue another; red is supposed to be action-only. Route both through one tone helper.
- **L6.** Dashboard hardcodes `alt="Tomco Painting"` + greeting (`page.tsx:298,307`) instead of `getOperatingCompany()` — a rename updates every doc but not the CEO's greeting.
- **L7.** Orphaned account `?tab=invoices` surface no nav points at anymore (all invoice links go to `/commercial/invoices?account_id=`) — redirect it or make it canonical, not both.
- **L8.** Account breadcrumb lands on different tabs from deal-detail (`?tab=opportunities`) vs invoice-detail (Overview) — pick one.
- **L9.** Empty AR donut on a fresh workspace draws a bare gray ring ("is this broken?"); proposals board + dashboard already guard the identical case with a text empty-state. Apply the same guard (`invoices/page.tsx:998-1019`).

---

## 🧭 DECISIONS — ✅ ANSWERED BY KARAN 2026-08 (build to these)
- **D1 — Win rate:** ✅ ONE definition everywhere = **won ÷ (won+lost) by `decided_at`, NOT debrief-gated**, same period on the tile and the report it links to. Apply to H1 + M1.
- **D2 — Margin basis:** ✅ Headline everything on **billed-based (margin to date)** (matches the dashboard + P&L cards). Contract-based may appear ONLY as an explicitly-labeled "vs budget / vs contract" secondary line — never under the bare word "margin." Apply to H2.
- **D3 — Needs-debrief scope:** ✅ **pre-sale-closed won/lost only** — the debrief is a win/loss-moment thing; advancing into delivery clears the badge. Align count + filing UI + cron to this one set. Apply to H4.
- **D4 — Proposal ID:** ✅ **join the shared family — `PROP-2026-0042`, revisions `-R2`** — matching OPP/WO/TRANS. Render via `proposalRecordId(project_number, revision)`; retire `formatProposalNumber` + the dead duplicate helpers. Apply to H6.
- **D5 — Open a deal:** ✅ a deal-click **always opens the drill-in** (`?tab=projects&project=`); kill the auto-pop `&edit=` sheet everywhere. Apply to M7.

The **surgical** items (H3, M4, M5, M6, L2–L9) need no decision — batch immediately.
