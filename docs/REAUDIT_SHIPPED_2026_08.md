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
