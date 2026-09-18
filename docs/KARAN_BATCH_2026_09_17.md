# Karan's batch — 2026-09-17 (go-live day)

Twenty-three items, given as one list. Tracked here so none is quietly dropped,
and so "done" means something specific per line rather than for the batch.

Status: `TODO` · `WIP` · `DONE` (with commit) · `DEFERRED` (with why) · `ASK`
(blocked on a person).

---

## Done today

| # | Item | Status |
|---|---|---|
| 20 | AR sheet: clicking an invoice opens THAT invoice | **DONE** `fb9b1685` |
| 21 | Labor payouts from Salesforce not showing | **DONE** `0457ed09` |

## Dropped by Karan

| # | Item | Status |
|---|---|---|
| 22 | Material ordering — gallons not saving to the email | **DROPPED** — "disregard the material ordering as well" |

## Deferred by Karan

| # | Item | Status |
|---|---|---|
| 13 | Smart projected calendar | **PLANNED** — docs/PROJECTED_CALENDAR_PLAN.md. Steps 0-2 shipped (`b9a38e18`, `d328deaa`). Build deferred as asked. **Key finding: all 46 open deals have no expected start, so a calendar built today shows an empty month — capture comes first** |

---

## The list

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Filter opportunities by account | **DONE** `93681ce2` | |
| 2 | Every navigation lands at the TOP of the page | **DONE** `4eaa8ef9` | Suspect an inner scroll container, not Next's scroll restoration |
| 3 | A won job must still be editable | **DONE** `7223ae28` | |
| 4 | Work Order needs a save button | **DONE** `3ea21f93` | |
| 5 | Wider "monitor" view toggle, next to light/dark | **DONE** `4eaa8ef9` | |
| 6 | Stage vs Status — what is the difference? | **DONE** `7223ae28` | Answer first; may be a naming fix rather than a feature |
| 7 | Delivery buttons need to be properly clickable | **DONE** `4eaa8ef9` | Third time asked — see the delivery-UI memory |
| 8 | Buttons take ~5s to respond | **PARTIAL** `f91103b4` | My first measurement was wrong (grepped files, not controls). Real count was 3, now 0, with `npm run` check to hold it. Deal page's 4 sequential reads parallelised: 186ms → 78ms. **Remaining:** every server action does createClient + getUser + assertCommercialAccess before any work, then revalidates a 4,000-line page. Bigger change, not for go-live day |
| 9 | Field scheduling: default times 7am–3pm | **DONE** `3ea21f93` | |
| 10 | Field Ops "mark off" — what is it, make it simpler | **DONE** `efc99e85` | |
| 11 | Labor costs should appear under an opportunity's Costs | **DONE** `3ea21f93` | Careful: hours ≠ money, never sum (see labor report) |
| 12 | Calendar week view | **DONE** `efc99e85` | |
| 14 | AR sheet date filters (30 / 90 days) | **DONE** `bec55d75` | **Trap:** carried-over rows have `issuedYmd = null` and would vanish |
| 15 | Notifications | **PARTIAL** `de295eaf` | Audit found 10 defects. The two that DROP notifications are fixed (Vercel freezing fire-and-forget work; a transient lookup error discarding and reporting success). Four smaller ones open — see below |
| 16 | Add due dates | **DONE** `b9a38e18` | Due-date fields (RFP received, proposal due, follow-up) were already inline-editable. Expected start/finish were NOT — now are, plus 6 other allowlisted fields that had no control |
| 17 | Invoices flow into the AR sheet; views by account; notes/editing; account names are the source of truth | PARTIAL `bec55d75` | **Views by account: DONE.** Notes/editing already exist under "Edit the sheet". Remaining: account names as source of truth — blocked, see below |
| 18 | RFP — when we think the project will happen | **DONE** `d328deaa` | Expected start editable + two attention rules. See docs/PROJECTED_CALENDAR_PLAN.md |
| 24 | "Bid range $2.1M-$2.1M" is confusing | **DONE** `7223ae28` | Added mid-batch. 34 of 34 priced open bids have low === high |
| 25 | One-off work order auto-creates a job/opp, tagged | **DONE** `c125e0a7` | Migration applied. `npm run check:one-off` green end to end |
| 26 | Labor on the deal (who's scheduled, when, total cost) | **DONE** `790774e6` | |
| 27 | Better multi-select filters (Salesforce-style) | **DONE** `a1839423` | Stage + GC multi-select, clear-all. Estimator/Mine NOT built — 0 of 132 deals have an estimator |
| 19 | Back button lands on an old/retired page | **DONE** `4eaa8ef9` | Suspect redirect-only routes left in history |

---

## Closing item — Karan, mid-batch

**Configure and set the emails.** Three steps, all outside the code:
1. Verify `tomcopainting.com` in Resend (DKIM/SPF in Tomco's DNS). Blocker —
   only `orders.precisionpaintingplus.net` is verified today.
2. Vercel → Production env: `COMMERCIAL_INVOICE_FROM_ADDRESS=finance@tomcopainting.com`
   and `COMMERCIAL_PROPOSAL_FROM_ADDRESS=estimating@tomcopainting.com`.
3. Redeploy — env vars only take effect on a new deployment.

The cc's already work: invoices cc mary@, proposals cc Brendan. Kim Laude shares
estimating@, so step 2 covers her.

---

## Rules for this batch

- **Check edge cases before AND after each change** (Karan, explicitly).
- **Nothing may break the projected calendar (#13).** It is deferred, not
  cancelled, so every change here has to leave room for it — in particular
  anything touching the Field Ops calendar, opportunity dates, or status.
- Money vocabulary stays as agreed: **won, not invoiced** — never "earned".
- Hours and labor payouts are two counts of the same work and are never added.
