# AIA billing → deal financials integration (Phase D finding, 2026-08-14)

## The problem
AIA progress billing (G702/G703) is a **separate ledger** from `commercial_invoices`
— issuing/paying an AIA application writes **no** invoice row. But every financial
rollup sums only `commercial_invoices`. So a job billed via AIA (the standard
method for commercial GC work — what Tomco does) reads **"$0 billed / nothing
billed yet"** on:

- the deal **P&L + margin** (`getProjectFinancials`)
- the delivery **Billing stage** (via `project-attention` money, fed by `getProjectFinancials`)
- the **invoice-new** page money summary
- the **dashboard** billed-of-contract bars + the **portfolio / Account 360 deal rollups** (`listProjects`)
- the **Account 360** top tiles (`commercial_account_overview_v` — a SQL view)

Confirmed by the CO-picker's own warning: a deal bills via **AIA _or_ regular
invoices, not both** — but the rollups only understand the invoice half.

## The definitions (standard AIA accounting — CONFIRM with Katie/Alex)
Implemented + unit-tested in `aiaBilledCollectedFrom` (`lib/commercial/aia/constants.ts`):

- **billed** = the LATEST issued (submitted/paid) application's cumulative
  **Total Completed & Stored to date** (G702 line 4) — the gross value of work
  certified to the GC, pre-retainage, directly comparable to the contract sum
  (also gross). Retainage is a payment-timing withholding, not a billing
  reduction, so it stays in.
- **collected** = Σ of PAID applications' **Current Payment Due** (G702 line 8) —
  the cash actually remitted (net of retainage). Retainage held stays
  uncollected, so `billed − collected` carries it as outstanding.

`aiaBillingRollup(oppId)` (`lib/commercial/aia/db.ts`) resolves these per deal and
returns `{ billedCents, collectedCents, hasAia }`. Both are **ready + tested**.

## Why it isn't wired yet
Wiring it into ONE surface (e.g. `getProjectFinancials`) without the others makes
the **deal page show $200k billed while the dashboard shows $0** — a new
inconsistency that violates "same number everywhere" and is worse than the
consistent-but-wrong status quo. So the fix must land across all surfaces at once.

## The coordinated build (turnkey)
1. **`getProjectFinancials`** (deal detail) — add `aiaBillingRollup(oppId)` to the
   `Promise.all`; when `hasAia`, `invoiced += billed`, `billedPreTaxCents += billed`,
   `collectedCents += collected`, `openBalance += max(0, billed − collected)`.
   Additive with invoices (a both-ledgers deal is the flagged double-bill).
   *(This exact change was prototyped + reverted in commit history — re-apply.)*
2. **`listProjects`** (batch: dashboard / portfolio / Account 360 deal rollups) —
   it already carries `latestAppStatus` per deal; resolve `aiaBillingRollup` only
   for deals whose latest app is submitted/paid (bounded fan-out), fold in the
   same way. Watch batch latency on large portfolios.
3. **`commercial_account_overview_v`** (SQL view — the hard one) — `total_invoiced`
   / `total_paid` are SQL aggregates over invoices. Options: (a) replace the view's
   money tiles with an app-code rollup that adds AIA, or (b) add an AIA billed/
   collected summation in SQL (replicating the G702 line-4 / line-8 math over
   `commercial_aia_line_items` + retainage — complex; keep it in lockstep with
   `computeG702`).
4. **Tests**: `aiaBilledCollectedFrom` is unit-tested; add integration coverage for
   a deal with issued + paid apps once wired.

## Open finance questions for Katie / Alex (before wiring)
- Confirm **billed = gross Total Completed & Stored** (vs net-of-retainage). This
  changes the dashboard number materially.
- How is an AIA payment recorded today — does marking an app `paid` mean the GC
  remitted the current-payment-due, and is retainage released via a final app?
- Should retainage held show as its own tile, or just sit inside outstanding?
