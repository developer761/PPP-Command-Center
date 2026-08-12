# Flow + Logic punch-list (2026-08) — broken flows & wrong business rules

From a 6-lane + adversarial-verify workflow (18 raw → 17 verified → 11 after
dedup, 0 agent errors) tracing the real deal lifecycle and the money/status rules.
Distinct from consistency (same number twice) and completeness (missing a piece):
**this is where the flow dead-ends/reverts or the business logic is wrong.**

Ownership: **build session** fixes; verification session found + rechecks.
💰 = money-correctness. Several "medium" are money bugs — treat by the 💰.

> Two items overlap the in-flight specs (noted **[overlaps …]**) — fold them in
> there so they're not solved twice.

---

## 🔴 HIGH — money / reporting correctness

### F1. 💰 Re-quoting a WON deal silently replaces the signed contract with an in-progress draft
An estimator clicks "New revision" on a won $450k deal (an anticipated flow) and starts typing rev-2 lines. `createProposal`'s parent-supersede (`proposals/db.ts:291-296`) runs **unconditionally**, flipping the won proposal to `superseded` → **no proposal has status `won`**. `pickContractBaseCents` then falls to `latestProposalCents`, computed as the **highest revision number's total regardless of status** (a draft counts). So contract-to-date, gross margin, left-to-bill, over-billed, and the **AIA G702 "Original Contract Sum"** all silently swing to the unfinished draft's running total — overriding the $450k the customer signed.
**Expected:** the signed contract stays the base until a NEW revision is itself won.
**Fix:** snapshot `accepted_contract_cents` on the opp at win time (or fall the ladder back to the most-recent won/superseded-from-won total, and gate the `latestProposal` fallback to non-draft statuses) so a WIP revision can't become the contract until sent/won.

### F2. 💰 AIA G702/G703 stop footing on any post-seed CO — and issued certificates silently restate
The G703 schedule-of-values is a **frozen snapshot** (written once at seed), but G702 lines 1/2/3 **recompute live on every read**, including submitted/paid certs (`aia/db.ts:482-513`, `change-orders/db.ts:93-102` sums all approved COs live). So a CO approved after the seed (or any CO on App 2+, or a post-submission CO, or a new won revision) moves G702 line 3 while the frozen G703 total stays put: **exported G702 line 3 ≠ G703 grand total** (breaks the AIA footing invariant), and an **already-issued immutable certificate restates its contract sum / % complete / balance-to-finish**.
**Expected:** within an app, G702 line 3 = G703 SOV grand total; an issued cert is frozen.
**Fix:** snapshot lines 1 + 2 onto the app at submit and have `resolveG702` use the snapshot for non-draft apps; while draft, keep the G703 SOV synced to the live approved-CO set (inject/rescale a synthetic SOV line per approved CO) so `Σ scheduled_value = original + net COs`, then freeze on submit. At minimum, stop pulling live COs/proposal ladder for submitted/paid certs.

### F3. 💰 `decided_at` is mismanaged three ways → wins dropped / mis-dated
`decided_at` stamps only on entry to `TERMINAL_STATUSES = {pre_sale_closed, post_sale_closed}`. So: **(a)** dragging a Sent proposal straight into a delivery column (verbal yes) leaves `decided_at` null → `wasWonInPeriod` drops the win from "Wins this month" AND from the win-rate denominator; **(b)** close-out re-stamps `decided_at` to the close-out date, so a reopened March win re-counts as an August win; **(c)** a within-`pre_sale_closed` lost→won re-decision never restamps, so `decided_at` keeps the stale prior date.
**Fix:** stamp `decided_at` on first entry into any won/delivery state while null; restamp when the tuple crosses won↔lost; move close-out to a separate `closed_out_at` column so `decided_at` is never clobbered (lets `wasWonInPeriod` drop its post_sale_closed special-case). **[overlaps OVERVIEW spec's won-not-started + M1 win-rate — coordinate.]**

---

## 🟠 MEDIUM

### F4. 💰 Completing a no-bid debrief reclassifies the deal as a plain Loss
`loss_reason` is overloaded to encode BOTH the deciding factor AND the `no_bid` discriminator. The debrief factor grid excludes `no_bid` but requires a factor, so finishing a no-bid debrief **overwrites `loss_reason` from `'no_bid'` to e.g. `'price'`** (`debrief.ts:235-239`) — destroying the marker. Every outcome derivation now reads it as a normal Loss, and it starts counting in `winRatePct` (which is supposed to exclude no-bids).
**Fix:** don't overwrite `loss_reason` when `outcome==='no_bid'` (or store the no_bid/lost discriminator in a separate column from the deciding factor).

### F5. 💰 Void → reopen-to-draft leaves a full payment on a "draft" invoice → collected cash disagrees
`void → draft` is allowed (mis-void recovery) but `changeInvoiceStatus` writes only status — it never reconciles `paid_cents` or payment rows (`invoices/status.ts:44-117`). Result: a **draft invoice still holding a $1,000 payment**. `sumCommercialPaymentsSince` counts it in "Paid this month" (excludes only void/deleted, not draft) while the account/deal Collected tiles drop drafts → the **same $1,000 shows as collected on the dashboard but $0 on the account**.
**Fix:** after any transition into `draft`, re-run the `paid_cents → status` reconcile (paid≥total → paid, paid>0 → partial), or refuse `void→draft` while `paid_cents>0`.

### F6. 💰 Operator-entered "Original contract $" on the AIA is accepted then silently ignored
`pickContractBaseCents` ranks the proposal ladder ABOVE `original_contract_cents`, so whenever any proposal exists the AIA settings field the operator types (to correct the contract on the cert) is **persisted then discarded** — the tile and the G702 keep showing the proposal-derived number.
**Fix:** when `original_contract_cents` was explicitly user-entered (not the bid-mid default), rank it above the ladder; OR disable the field when a proposal drives the contract so the UI and derivation agree.

### F7. Dragging a deal to "Proposal" with an unsent proposal succeeds, then the reconciler snaps it back
Dropping Estimating→Proposal when the current proposal is still draft/approved writes `(proposal, sent)`, but `reconcileDealStatesFromProposals` (runs on every pipeline/proposals render) derives from the proposal status and **flips it back to Estimating** — the card moves, then reverts on refresh with no explanation.
**Fix:** in move-status, reject the drop with an explanatory 409 ("Send the proposal to move this deal to Proposal") instead of writing a state the reconciler will undo. **[overlaps OVERVIEW spec §4 — the reconciler-vs-move conflict; the shared `stageRank`/forward-only work should make move-status reject loudly.]**

### F8. After a Win, the "Start Project" handoff is a maze
`StartProjectCard` (the only Won→Pre-Construction control) exists **only on the debrief page** and is gated on `isDebriefed` — but the debrief is presented as optional, and `submitDebriefAction` **unconditionally redirects away** the instant the debrief saves, leaving the page right when the card would render. The user lands on the `won_not_started` panel whose only guidance is prose ("Move it to Pre-Construction") with **no button**. Meanwhile the deal-row dropdown advances Won→Pre-Construction with **no** debrief — the two paths are inconsistent, and winning from the proposal kanban returns `debrief_url=null` (zero onward prompt).
**Fix:** add a real "Start project" action to the `won_not_started` panel wired to `startProjectAction`; branch `submitDebriefAction` so a won deal returns to the debrief page (where the just-unlocked card renders); drop the `isDebriefed` precondition on Start Project; give every Win entry point the same prompt. **[overlaps OVERVIEW spec's WON-not-started card — build the CTA there.]**

### F9. Marking Lost/No-Bid from inside an account kicks you out to the global deal shell
The Won and plain flips stay in-account, but `isLostFlip` redirects to `/commercial/opportunities/{opp}` with **no `account_id`** (`accounts/[id]/page.tsx:2906-2908`), so you lose the account tab/scroll/deal drawer — even though the account-scoped debrief page already fully supports lost/no_bid.
**Fix:** route `isLostFlip` to the account-scoped debrief page like the Won path, and extend that page's auto-flip gate + form to collect the loss reason for a Lost/No-bid close.

### F10. Invoice "Due" countdown + rose tone fire a full day early (timezone)
The header/milestone due countdown uses a raw 24h instant diff, not ET calendar days, so a milestone/invoice reads **"1 day overdue" at ~noon ET on its own due date** and the header shows "Sent" + "1 day overdue" simultaneously (`invoices/[id]/page.tsx:703,1161`; `format.ts:70-75`). The badge (`deriveInvoiceStatus`) was already ET-fixed; the header/milestone path was missed.
**Fix:** compute the countdown from ET calendar days (match the badge) for both the sub-label and the rose-tone gate + the milestone segment.

---

## 🟠 MEDIUM — the "everything under the deal" IA (Karan, repeatedly)

### F12. Opening a deal SUB-ITEM breaks OUT of the deal drill-in to a standalone page
**Karan has raised this many times — it's the flagship IA rule: everything for a deal lives *under that deal*, no jumping to standalone pages.** Status:
- ✅ The drill-in **embeds the tool LISTS** correctly — Submittals/Invoices/AIA/COs/Closeout/Costs render inline via `?tab=projects&project=<id>&dt=<tool>` (`accounts/[id]/page.tsx` renders `<SubmittalsTool variant="inline">` etc.). Good.
- ❌ But opening an **individual item** navigates to a **standalone full-page route**, dropping the account/deal chrome + the `?tab=projects&project=` URL:
  - a **submittal** → `/commercial/accounts/[id]/submittals/[dealId]/[sid]` (the SUB-001 "Submittal documents" click Karan hit)
  - a **proposal** → `/commercial/accounts/[id]/deals/[dealId]/proposal/[proposalId]`
  - (the `?back=` param is carried, so the *back button* returns to the drill-in — but the click itself is a full-page jump out, which is exactly the "it brought me to the submittals page" complaint. Back-carrying mitigates the return; it doesn't satisfy "keep me here.")

**Expected (Karan):** clicking a submittal / proposal / any deal item KEEPS you in the deal drill-in — the item detail renders inside `?tab=projects&project=&dt=…` (e.g. `&dt=submittals&sub=<sid>`), account+deal chrome intact — and closing it returns to the same tab/scroll. And **vice versa**: reaching an item from a global list (the Proposals index, the global Submittals log) should still land you in the deal's context, not a bare page.

**Fix (the real one):** render the sub-item detail *inside* the drill-in as a sub-view of its tool tab, not as a separate route — either lift the detail component into the `dt=<tool>` render with a `&sub=<id>` param, or a right-slide-out sheet over the drill-in (the pattern Karan likes for detail). **Sweep the whole class** — submittal detail + proposal editor are the two that fully break out today; verify every other deal item (invoice detail lives at the global `/commercial/invoices/[id]` — same class) either renders in-context or is a deliberate exception. Interim (if the full in-drill-in render is deferred): make EVERY entry point carry `?back=<drill-in>` AND give the standalone page the account/deal chrome so it doesn't read as a different place — but the target state is in-drill-in.

---

## 🟡 LOW
### F11. Reopening an EXPIRED proposal shows the "Withdrawn." banner
`reopenExpiredAction` redirects with `?approval=withdrawn` (`proposal/[proposalId]/page.tsx:661`), reusing the withdraw-approval banner — wrong header for "reopened from expired."
**Fix:** add a dedicated `?approval=reopened_expired` flag + banner.

---

## Do-first order for the build session
1. **F1, F2** — the contract-base + AIA footing bugs. These silently corrupt the numbers on the customer's signed contract and payment applications; nothing is higher.
2. **F3, F4, F5, F6** — the other money/reporting-correctness ones.
3. **F7–F10** — flow breaks (F7 ties into the auto-advance spec).
4. **F11** — polish.
Verification session rechecks each against the code.
