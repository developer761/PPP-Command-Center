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
| 13 | Smart projected calendar (nudges, crew capacity, pin/filter, color by stage, attached-vs-projection toggle) | **DEFERRED** — "we can defer for now", but **plan it**, and nothing else in this batch may break it |

---

## The list

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Filter opportunities by account | TODO | |
| 2 | Every navigation lands at the TOP of the page | TODO | Suspect an inner scroll container, not Next's scroll restoration |
| 3 | A won job must still be editable | TODO | |
| 4 | Work Order needs a save button | TODO | |
| 5 | Wider "monitor" view toggle, next to light/dark | TODO | |
| 6 | Stage vs Status — what is the difference? | TODO | Answer first; may be a naming fix rather than a feature |
| 7 | Delivery buttons need to be properly clickable | TODO | Third time asked — see the delivery-UI memory |
| 8 | Buttons take ~5s to respond | TODO | Perf. Measure before changing anything |
| 9 | Field scheduling: default times 7am–3pm | TODO | |
| 10 | Field Ops "mark off" — what is it, make it simpler | TODO | |
| 11 | Labor costs should appear under an opportunity's Costs | TODO | Careful: hours ≠ money, never sum (see labor report) |
| 12 | Calendar week view | TODO | |
| 14 | AR sheet date filters (30 / 90 days) | TODO | **Trap:** carried-over rows have `issuedYmd = null` and would vanish |
| 15 | Notifications | TODO | Needs scoping — ask what is wrong with them today |
| 16 | Add due dates | TODO | Needs scoping — due dates on what? |
| 17 | Invoices flow into the AR sheet; views by account; notes/editing; account names are the source of truth | TODO | Several sub-items |
| 18 | RFP — when we think the project will happen | TODO | Feeds #13 |
| 19 | Back button lands on an old/retired page | TODO | Suspect redirect-only routes left in history |

---

## Rules for this batch

- **Check edge cases before AND after each change** (Karan, explicitly).
- **Nothing may break the projected calendar (#13).** It is deferred, not
  cancelled, so every change here has to leave room for it — in particular
  anything touching the Field Ops calendar, opportunity dates, or status.
- Money vocabulary stays as agreed: **won, not invoiced** — never "earned".
- Hours and labor payouts are two counts of the same work and are never added.
