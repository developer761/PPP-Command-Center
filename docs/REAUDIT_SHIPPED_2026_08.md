# Re-audit of the just-shipped batch (2026-08)

Side-by-side re-audit of the batch that cleared spec/punch-list items (Overview
phase-swap, one-margin, Closed column, crew scope, Won-card/welcome), each checked
against the exact rule it was meant to satisfy AND the code. 6 lanes + adversarial
verify (33 raw findings). **This is not the original findings re-listed — it's
where the fix is incomplete, wrong, or regressed.** Ownership: build session.

Bottom line: the plumbing/structure is mostly good; several **details are wrong**,
and **three are real regressions** — fix these before the auto-advance handoff.

---

## 🔴 CRITICAL — regressions & a decision built backwards

### R1. 💰 The margin fix was built on the WRONG basis — CONTRACT, the opposite of decision D2
`dealMargin()` headlines `grossMarginPct` = **(contract − costs)/contract** (`financials.ts:100-101`) under bare "Gross margin", on the deal Overview tile (`accounts/[id]/page.tsx:1581-1584`) and P&L tab (`:2574-2577`). **D2 answered: headline = BILLED-based; contract only as a labeled "vs budget" line.** The commit comment (`financials.ts:144-147`) literally argues "Contract-based wins" — it overrode the decision. Result: the two deal surfaces now agree with *each other* (good) but on the basis D2 rejects, and now **disagree with the dashboard bars + account Profitability rollup** (both billed-based) — the exact split H2 set out to end.
**Fix:** flip `dealMargin()` to `(billedPreTaxCents − totalCostCents)/billedPreTaxCents`; keep contract only as a separately-labeled "vs contract (budget)" line; re-pin the tests. **This one flip also auto-resolves R2, R3(part), and the dashboard/account/reports splits below.**
- *(The unification mechanism + labels/over-budget-words/caveat are verified GOOD — only the basis is wrong.)*

### R2. 💰 Two margin bases on ONE card (opposite sign + color) — H2 reintroduced
Same "Profitability" card: **Net profit** is billed-based dollars (`:1575`, `dealGrossCents = billedPreTaxCents`), **Gross margin** beside it is contract-based % (`:1580-1585`). Header even asserts "Gross = billed, Net = billed − costs" while the margin tile is contract. Example (contract $100k, billed $50k, costs $60k): **Net −$10k (red) next to Gross margin 40% (green)** on one card. Resolved by R1's flip.

### R3. Closed-column REGRESSION — fully-closed accounts now flood the board
The batch added `post_sale_closed` to `TERMINAL_COLUMN_KEYS` so cards land in a Completed bucket — but `anyOnBoard` (`opportunities/page.tsx:2320`) still reduces over **ALL** `byStatus`, so a 100%-closed account is no longer filtered out and renders **7 empty open columns beside one Completed cluster** — the exact "wall of empty columns" §5 exists to prevent. (Stale comment at `:2313-2317` now false.)
**Fix:** `const anyOnBoard = OPEN_COLUMN_KEYS.some(k => (a.byStatus.get(k)?.length ?? 0) > 0);` (fully-closed accounts stay off the live board, reachable via the drawer).

### R4. 🔐 Crew welcome-email REGRESSION — a same-minute new hire gets NO schedule/scope + no clock nudge
The `<10min` dup-suppression (`schedule-email-send.ts:452-454`, keyed on the employee row's age) is built on a false premise: the welcome is sent at **creation**, before any assignment exists, so it carries **no schedule**. The natural flow (create a hire, drop them on this week's job within 10 min) then trips the suppression and **early-returns before the shift email — the ONLY email carrying schedule AND scope** — and before reminder scheduling, so **clock-in nudges are skipped too**. Also suppresses valid day-8+ shifts (no window check).
**Fix:** stop keying on row age. Send the welcome after the first assignment, or track a real `welcomed_at` + the dates it carried and only collapse when the welcome genuinely included the same workdate. As written the welcome is never redundant with the first shift email — the dedup is pure information loss.

### R5. Crew scope reaches only 1 of 4 email paths
`shiftLine`'s scope arg is optional, so scope-less calls compile silently. Scope is threaded only in the shift-assignment email (`:472`). The **day-of cron** (`:636` — the "what am I painting today" morning email), the **weekly** (`:690`), and the **welcome** (`:405`, via `buildBody:233`) all omit it. So most crew on most days get a schedule email with no scope.
**Fix:** thread `getCrewScopeForOpp(opp, wo)` (dedup per opp|wo) into `buildBody:233` and the day-of block `:636`, exactly as the shift email does.

### R6. Crew scope folds in ALTERNATES — crew could paint an unsold add-on
`getCrewScopeForOpp` (`work-orders/db.ts:649-650`) does `[...inclusions, ...alternates]` and counts alternates in `totalLines`. Crew surfaces render one flat bullet list, so an **optional alternate is presented as base "Scope:" work**; and a WO covering all real inclusions but not the alternates falsely reads **"5 of 7 — the rest is on another sheet"** when there is none.
**Fix:** exclude alternates from crew `lines`/`totalLines` (base inclusions only); if surfaced, a separate "Alternates (optional)" field, never in the partial denominator.

---

## 🟠 MEDIUM — half-solves & new inconsistencies

- **R7. Standalone deal page not phase-gated.** The account page got `dealPhase`; `opportunities/[id]/page.tsx:1693-1714` still renders Bid/Probability/Weighted/Decision-in ungated → a won/lost deal reached via a debrief/bell **deep-link** shows a forecast Weighted + "Decision in — overdue." Apply the same `dealPhase` gate.
- **R8. AccountHome buckets won-not-started as "In delivery" (M2 not coordinated).** `:845,:897` — a just-won deal reads "Won · ready to start" on the detail page but "In delivery" with a rich ProjectCard on account home. Split via `dealPhase`/`IN_DELIVERY_STATUSES`.
- **R9. Phase pill still green for won-not-started.** `:1404-1410` else→emerald, so a green "Won" pill sits above the navy "Won" card. Add `won_not_started → navy`.
- **R10. "Won — ready to start" card hardcodes "Nothing is billed yet"** (`:1519`) gated only on status — a deposit/mobilization invoice (creatable on a won opp without a status change, and auto-advance isn't shipped) makes the card assert "nothing billed" **above a Profitability block showing billed > 0**. Gate the copy on `billedPreTaxCents===0`, or suppress the card when `hasDeliveryActivity`.
- **R11. 💰 costs-tool.tsx (deal Costs & P&L) untouched** — still stacks a contract-based "Gross margin" tile over a billed-based "margin" gauge, both bare-labeled (`:341-345` vs `:399`). Core H2 defect on this surface. Route both through the D2 basis.
- **R12. Margin gauge rings show raw pct** (`:1593`, `:2586`) — a $0-costs deal shows a **100% emerald ring** next to a StatCard saying "No costs booked yet"; over-budget prints a literal **"-4900%"**. Feed the gauge from `dealMarginInfo` (neutral ring + honest string).
- **R13. Reopen to a DELIVERY lane doesn't clear `decided_at`** (`status.ts:287-288` fires only for `PRE_SALE_OPEN_STATUSES`) → a Completed→In-Progress reopen keeps the close-out-month date and is **counted as a win in the close-out month**. Add a source-keyed delivery-lane clear (distinct from a won→delivery advance, which must NOT clear). *(overlaps flow-logic F3.)*
- **R14. Pre-sale → post_sale_closed not warned.** Not in `WARN_TRANSITIONS`, and the board drop path never calls `shouldWarnTransition` — dropping a pre-sale card on Completed **silently stamps a close date and is never counted as a win**. Add the entries + wire the board drop to confirm.
- **R15. L5 status-color not unified.** `PipelineDealBlock` inline tone (`:955-960`) still disagrees with `statusPillTone` (`:5745`) for the same status (estimating blue vs amber; lost charcoal vs rose). Extract one tone helper both consume.
- **R16. Magic link shows only `assignments[0]` scope** (`app/f/[token]/page.tsx:60-62`) — a painter on two jobs in a day sees only the first job's scope. Render one block per assignment (dedup by job_id).
- **R17. 💰 Dashboard bars (billed) vs deal pages (contract) mismatch** — a bar reading "40% net" deep-links to a P&L showing a different contract-based %. Resolved by R1.

---

## 🟡 LOW
- **R18.** Closed cluster count badge undercounts (sums the sliced ≤10, shows "10" when 31 exist); no per-account "view all" (`opportunities/page.tsx:2514`).
- **R19.** `getProjectFinancials` runs unconditionally for every phase (`:1148`) — §3 said gate to in-delivery. (§3e/won-card need *some* money data, so partial.)
- **R20.** `bidDetails` "Bid range" shows on won/lost/in-delivery (`:1296`) — forecast value post-sale. Low (legacy fields only).
- **R21.** `listProjects.grossMarginPct` still contract-based (`projects/db.ts:362`) — anchors the Job-Costs/Geography **reports** to the wrong basis. Align with R1 or expose both named.
- **R22.** Stale comments at `:1164-1173` now misdescribe `dealMargin()` (say "net÷gross ... same guard as the dashboard" — both false now). Fixed for free by R1.
- **R23.** `statusPillTone` still emerald for won/completed (`:5750,5752,5762`) — contradicts the navy card. Sweep or pin the carve-out.

---

## ✅ Verified CORRECT (don't touch)
- **Core phase-swap** — `dealPhase()` is 3-way keyed on status (not `isPostSaleProject`); PRE tiles "—/Not priced yet" (never $0); WON card suppresses billed/AR; LOST gates `loss_reason` on `debriefed_at`; post-sale P&L uses `billedPreTaxCents`/`openBalanceCents` with the contract=0 / cost=0 / unrated-hours guards. §3 met.
- **Margin unification mechanism** — one shared `dealMargin()`, honest $0-cost + over-budget labels, caveat. Only the **basis** is wrong (R1).
- **Closed column** skip-if-same-column guard (no `·closed`→`·closeout` downgrade) + distinct "Completed" header.
- **Field Ops job-card** scope lane (respects the WO's own partial scope, truncates, i18n correct).
- **Won card navy** (fully navy, no emerald) + **welcome name** now re-reads current `first_name` (the "Hi k" fix).

---

## Do-first for the build session
**R1 first** (flip margin to billed — auto-fixes R2, R12-part, R17, R21, R22), then **R3 + R4** (board flood + new-hire email regressions), then R5/R6 (crew scope reach + alternates), then the R7–R16 half-solves. Verification session rechecks each.

---

## Round 2 re-audit — the margin sweep (c6c9f9f) is INCOMPLETE

### R24. 💰 "One margin everywhere" missed ≥4 surfaces — still contract-based, now the odd ones out
`marginFrom()`/`dealMargin()` are correctly billed-based, and the deal Overview, deal P&L, dashboard bars, and Costs tool now route through them (verified good). But the commit's claim "routes all six through it **including reports**" is **false** — these surfaces still render the contract-based `grossMarginPct` (`projects/db.ts:362`, `financials.ts:101`) as bare "% margin", so the SAME job shows a billed margin on its deal page and a contract margin here:
- **Reports** — `reports/job-costs.ts:142` (`p.grossMarginPct`), `:175`/`:192` (`pct(…, contract)`), `reports/geography.ts:73` (`pct(a.marginCents, a.contractCents)`). Bare "Margin", contract-based.
- **Global Costs index** — `app/commercial/post-job/costs/page.tsx:43` (`${p.grossMarginPct}% margin`).
- **Invoice-new preview** — `app/commercial/invoices/new/page.tsx:105` (`${fin.grossMarginPct}%`).
- **Account Transactions mini-card chip** — `accounts/[id]/page.tsx:1744` (`${p.grossMarginPct}% margin`) — it does add a "vs $X contract" sub-line (`:1751`), so it's the borderline one, but the chip value still differs from the deal Overview's billed margin.
**Fix:** route these through `marginFrom(billedPreTaxCents, totalCostCents)` (reports need `billedPreTaxCents` threaded into their aggregates), or — if a report deliberately wants margin-vs-budget — label it explicitly "Margin vs contract", never bare "Margin". Either way the same job must not read two different margins. R21 (in the flow/consistency list) is the data-layer root: `listProjects.grossMarginPct` is still contract-based and feeds the reports.

### R25. 🔴 Migration-126 guard MISSING on the main opportunities UPDATE — a pre-126 deploy rejects every manual status change
Commit `04e88b9` added pre-migration-126 graceful degradation to TWO of the three paths that touch the 126 columns (the `status_log` insert retries on missing `source`; the auto-advance READ retries on missing `status_user_set_at`) — but the **main `commercial_opportunities` UPDATE was left unguarded** (`status.ts:333` adds `patch.status_user_set_at` for `source==='user'`; `:357` runs the UPDATE and returns `{ok:false}` on error). If this deploys **before migration 126 runs**, the first manual status change (kanban drag, status dropdown, win/loss debrief) hard-fails with `column status_user_set_at does not exist` → rejected. **Strictly worse than pre-commit** (status changes worked before; the column just didn't exist) and it breaks exactly the human path (auto/reconcile moves skip the column). **HIGH.**
**Fix:** wrap the UPDATE like the `status_log` insert — on `updateErr` matching `/status_user_set_at/i`, `delete patch.status_user_set_at` and retry once (warn to run 126). (Or just make applying 126 a hard pre-deploy gate.)

### R26. 💰 Account "Bid range / Open bids" rollup has NO proposal fallback — "Open bids: 3" next to "Bid range: —"
The account overview SQL view `commercial_account_overview_v` (`117_*.sql:82-100`) sums raw `bid_value_low/high_cents` with no current-proposal fallback. Since the create forms no longer collect bid low/high, every new deal contributes $0 to these tiles — while `open_opps_count` (same status set) COUNTs it, so the account scorecard reads **"Open bids: 3 · in progress" beside "Bid range: —"**, and the per-deal `PipelineDealBlock` right below shows live money (it uses `dealValueCents` WITH the fallback). Same class as AUDIT #3 (fixed in app-code via `listCurrentProposalTotalByOpp`) but the **SQL view + its 3 consumers** were missed (`accounts/page.tsx:273-274,1056`; `accounts/[id]/page.tsx:7526-7527`). Consistency L1 only covered the board file, not this view.
**Fix:** give the account rollups the same proposal-total fallback — reuse `dealValueCents(opp, proposalTotal)` for the MiniFig and batch `listCurrentProposalTotalByOpp` for the book tile / AccountRow (or COALESCE the view's bid sums to the current-proposal total).

### R27. Proposal-trails badge (a2eaba7) false-positives on the MOST COMMON Proposal state → double badge
`proposalTrailsDeal` (`auto-advance-targets.ts:203-208`) returns true for a deal at `(proposal, follow_up)` whose latest proposal is `sent`: `subRank('proposal','follow_up')=1 > sent's 0` trips the same-rank sub-ladder branch. But `follow_up` **means** "a sent proposal we're chasing" — a sent proposal fully justifies it, no discrepancy exists. On that card `isFollowUpCard` is also true, so `page.tsx:2814-2841` renders **both** an amber "Follow-Up" badge **and** a navy "R{n} Sent" trailing badge — the exact contradictory noise the feature was built to prevent. Tests cover `follow_up+draft` (true) and `sent+sent` (false) but never `follow_up+sent`.
**Fix:** for `target.status==='proposal'` compare stage rank only (never the sub ladder); restrict the same-rank sub tiebreak to `estimating` (where `proposal_pending_approval` is real advancement). Add a test `proposalTrailsDeal(('proposal','follow_up'),'sent')===false`. Also reword the tooltip "is a approved" → "is in {label}".

### R28. Margin-sweep neutral-tone left the sibling "Net profit" card green → same triumph-reading, one row over
The `c6c9f9f` sweep made the **Margin** card NEUTRAL for $0-costs/provisional (keyed off `.provisional`), but the **"Net profit"** StatCard in the same KPI row still tones `net<0?'rose':'emerald'` (`accounts/[id]/page.tsx:1591`, `:2610`, `:7588`). For a no-costs deal, net = full gross, so the row paints the whole gross **green "profit"** beside a neutral Margin and a "Job costs $0" card — the exact "healthy job!" misread the sweep set out to kill, now inconsistent within one card row. (Distinct from R12, which was the gauge ring.)
**Fix:** tone Net profit `neutral` when `provisional` (reuse the flag these blocks already compute) so the whole row reads "nothing spent yet."

### R29. Cosmetic: malformed import line (`app/commercial/page.tsx:43`) — two `import` statements on one physical line. Compiles + runs; split for hygiene.

### R30. F1 fix — the AIA READ of `accepted_contract_cents` is unguarded (soft R25-class pre-127 issue)
F1 (`7f5ba29`) is **verified correct** — snapshot-on-win ladder, write-on-win (updates on a newly-won R2), 284 tests pass, tsc clean. But the AIA input read (`aia/db.ts:540`) does `.select("bid_value_low_cents, bid_value_high_cents, accepted_contract_cents")` with **no `isMissingColumn` guard** (the *write* path in `projects/accepted-contract.ts:95-97` has one; `projects/db.ts` reads via `SELECT *` so it degrades fine). Pre-migration-127, that explicit SELECT errors → `oppRow=null` → `o=null` → the AIA contract base loses BOTH the bid-mid fallback and the snapshot (resolves off proposals only). Not a crash (the error is swallowed by `maybeSingle`), but a wrong contract number on the AIA app until 127 is applied. Same class as R25 (the 126 UPDATE), lower severity.
**Fix:** either apply migration 127 as a hard pre-deploy gate (alongside 126), or guard the `aia/db.ts:540` read — retry the SELECT without `accepted_contract_cents` on a `/accepted_contract/i` error, reusing the existing `isMissingColumn` helper.

### R31. F2 fix — the issue-write of the frozen columns is unguarded pre-128 (R25 class, HARD)
F2 (`9f4cd73`) is **verified correct**: issuing freezes G702 lines 1/2 (migration 128), drafts still track live, a draft's G703 now injects a synthetic SOV line per approved CO so it foots, reopening releases the freeze, and the read is `SELECT *` (degrades pre-128). But `updateAiaApplication` (`aia/db.ts:413-417`) sets `next.contract_sum_frozen_cents`/`net_change_orders_frozen_cents`/`frozen_at` on ISSUE and then runs a plain `.update(next)` with **no `isMissingColumn` retry**. Pre-migration-128, issuing (draft→submitted) or reopening (submitted→draft) an AIA application hard-fails ("column does not exist") — you can't submit or reopen a payment application. Same class as R25 (126 UPDATE) and R30 (127 AIA read).

### ⚠️ CONSOLIDATED DEPLOY GATE — migrations 126, 127, 128 are HARD pre-deploy blockers
Three new-column migrations shipped, each with an unguarded write/read that breaks a real flow if the code deploys before the migration runs:
- **126** (`status_log` source / `status_user_set_at`) → R25: the first manual status change (drag/dropdown/win-loss) is rejected.
- **127** (`accepted_contract_cents`) → R30: the AIA contract number goes wrong (soft, swallowed).
- **128** (`contract_sum_frozen_cents` …) → R31: issuing/reopening an AIA application hard-fails.
**Action:** apply **126 + 127 + 128 before any deploy** (hard gate). Defense-in-depth alternative: wrap each write/explicit-read in the existing `isMissingColumn` retry so a pre-migration deploy degrades instead of breaking — the pattern the build session already wrote once (`projects/accepted-contract.ts:95-97`) but didn't apply to these three sites.

### R32. F12 proposal-editor fix — the line-item + rename actions drop the drill-in origin (its own headline example)
F12 proposal editor (`8603a75`) keeps the deal origin through the **13 R1d approval-workflow actions** (`proposalHref(…, proposalBack(formData))`, page.tsx:603-639) — verified. But three actions build the raw proposal URL with **no `proposalBack`**: `renameProposalAction` (error redirect :352), `addLineItemAction` (:393 error, **:435 success** `…#line-items`), `updateLineItemAction` (:428). Each of the three has **0 `proposalBack` calls**. So after adding/editing a line item (the single most common editor action) or renaming, the `?back=<drill-in>` param is stripped from the URL → the editor's back arrow reverts to its default (global proposals / account), losing the deal — **the exact "first line-item edit threw away where you came from" scenario the commit says it fixed.** Not a nav-out (you stay on the proposal page), but the origin is lost for the next back-click.
**Fix:** thread `proposalBack(formData)` into these three actions' redirects (as the 13 already do), AND ensure their `<form>`s emit the `back` hidden field (`name="back" value={backParam}`, page.tsx:975) — the line-item add/edit + rename forms need it or `proposalBack` reads empty. Trivial once the field is present.

### R33. decided_at fix VERIFIED CORRECT; migration 129 joins the deploy gate (R25 broadened)
`c79d9e7` is a proper root-cause fix — F3(a/b/c) + A1 + A3 + R13 were one bug (`decided_at` stamped only on terminal entry). Now: stamped on entry to won/delivery, restamped on won↔lost, close-out writes a NEW `closed_out_at` (migration 129) instead of clobbering `decided_at`, and `wasWonInPeriod` guards legacy pre-129 rows (`post_sale_closed && !closed_out_at → excluded`). 306 tests pass, tsc clean. **Verified correct.**
BUT the write of `closed_out_at` goes through the **same unguarded status.ts UPDATE as R25** (`status.ts:~394`, sets `status_user_set_at` [126] + `decided_at` + `closed_out_at` [129], `.update(patch)` with no `isMissingColumn` retry). **R25 is still open**, and now a pre-**129** deploy compounds it: the first win/close-out/manual status change hard-fails.
**Deploy gate is now 126 + 127 + 128 + 129** — all hard pre-deploy blockers. The single cleanest fix for R25/R33: wrap that one status.ts UPDATE in an `isMissingColumn` retry that strips whichever of `status_user_set_at`/`closed_out_at` is missing (covers 126 AND 129 at once), OR apply all four migrations before deploy.

### R34 (note). "Historical repairs" screen (`20f2d0e`) — well-judged, human-gated
F1/F2/decided_at each stopped the recurrence but left existing rows with wrong figures (erased signed contracts, restating certs, overwritten win dates) that a script can't safely fix. A Settings → Historical repairs screen that COMPUTES each proposed repair from history and requires a human to apply it is the right call. Isolated (`lib/commercial/repairs/`). Not deeply audited here (human-reviewed → low blast radius); a follow-up could verify the repair math per case, but no action needed to ship.

### R35. F4/F5/F6 VERIFIED CORRECT; migration 130 joins the gate (now FIVE) — the guard gap is systemic
`1f6b78f` fixes all three cleanly (verified): F4 the no-bid marker survives its debrief; F5 an un-voided paid invoice reconciles to paid/partial, never a payment-holding "draft"; F6 an explicitly-entered `original_contract_cents` outranks the proposal ladder via a manual flag. tsc clean, 309 tests pass.
F6 adds **migration 130** (`original_contract_is_manual`), with the same pattern: the write at `aia/db.ts:431` (`next.original_contract_is_manual = true` → `.update`) hard-fails pre-130 (editing the AIA original contract), and the explicit read at `aia/db.ts:701` (`.select("… original_contract_is_manual")`) errors pre-130 (soft). SELECT-* reads (`:621`) degrade fine.
**Deploy gate is now 126 + 127 + 128 + 129 + 130.** This is the 5th migration in a row shipped with an unguarded write/explicit-read — the gap is **systemic, not per-commit**. Recommendation to the build session: stop hand-guarding each and do it once — either (a) a pre-deploy checklist/CI gate that refuses to deploy if any migration is unapplied, or (b) wrap the two hot write paths (`status.ts` UPDATE, `aia/db.ts` update) in the existing `isMissingColumn` retry so every future new-column deploy degrades instead of breaking. The FIXES are all correct; only the deploy-order safety keeps repeating.
