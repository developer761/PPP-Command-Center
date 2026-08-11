# Commercial CC — Post-Meeting Master Plan (2026-08)

Source: Karan's client meeting notes + confirmed decisions. Build until 100% done, edge-cased, clear for Alex/Katie.

## Confirmed decisions
- **Shared ID per deal:** one number follows the deal → `OPP-1234` → `PROP-1234` → `PROJ-1234` → `WO-1234` (+ optional area suffix) → `TRANS-1234`. `ACC-####` for accounts. (Project = won Opportunity = same record, so OPP/PROJ already share a number; PROP is per-deal, revisions share it.)
- **Work Orders = a selection of scope items from the WON proposal**, optionally split by area (clean, optional), each with its own PDF/marked-up set. Multiple WOs per project. Feeds Field Ops (crew marching orders). Track assigned vs. unassigned scope so nothing's double-assigned or missed.
- **Teams** = defined in Settings/Admin (name + team admin + members with roles); on opp/account you pick the team and ONLY the name shows.
- **Post-contract statuses** = one "Closed" (tree below).
- **Proposal revisions** = no R# until after the first client send; locked at send-for-approval.
- **Contact lives on the opportunity** (varies per job), account contacts as quick-picks + add-new.
- **Crew role** = own WOs + schedule + clock + own analytics only; nothing else.

## Statuses
**Pre-Contract (Opportunity):** Qualifying · Request for Proposal · Estimating · Proposal · Closed Won · Closed Lost
**Post-Contract (Project) — Status → Sub-status:**
- Pre-Construction → Coordination · Ready to Mobilize
- In Progress → WIP On Site · WIP On Hold
- Billing → Substantial Completion · Completed & Invoiced
- Closed → Completed / Close-Out Docs

Only show relevant statuses per phase — create form, edit, pickers, filters, kanban, AND account/deal analytics. Kanban: move Closed between pre-sale and post-sale. Needs a migration map for existing deals.

## Blocks
1. **Statuses + Pre/Post split + migration** (foundation) — incl. account/deal analytics split.
2. **Opportunity page tabs by phase** — Pre: Proposals, Documents · Post: Submittals, Invoices, Work Orders, Change Orders, AIA, P&L, Closeout & Warranty, Transactions.
3. **New-Opportunity flow** — existing builder slim form (address, name, contact, team); ~~bid low/high~~; RFP defaults today; auto-title `MM-DD-YYYY Builder - Client - Street`; repeat-customer prefill; contact on opp.
4. **Shared IDs** + rename Cost → Transactions (`TRANS-####`).
5. **Work Orders from proposal scope** (biggest new build) + PDF upload + unassigned-scope indicator.
6. **Proposals** — ~~phone glitch~~; ~~Alternate→Qualifications~~; revision lifecycle (no R# pre-send, lock at send); bid-set→intro; Labor into Inclusions (Custom Time qty×rate; Materials flat); Proposal→Won logic fix; [PARKED: page order — Stephanie].
7. **Projects** — global All Active Projects list.
8. **Account page** — ~~remove tax exemption~~; assign a Team (by name).
9. **Teams** (Settings/Admin surface).
10. **Access & Crew role** — add Crew role; toggle help-text matches wording.
11. **Bugs** — Brendan sign-offs "weird"; global search bar "weird".
12. **Consistency sweep** — IDs/labels/statuses/terminology.

## Katie carryovers to fold in
Today's list shipped (B1/U1/U2/U3/U4/F1); parked #3 (typo), #8 ($8k proposal), F2 (submittal send). Prior open: CO lines on invoice, AIA templated-Excel, Kim proposal-build + Resend, Tomco Warranty/Work-Order doc formats.

## Statuses — SHIPPED as a display-layer flatten (2026-08, commit 7253b21)

No migration. The (status, sub_status) model already carried everything; RFP
was buried as a sub-status of Qualifying and "Proposal Drafted"/"Proposal
Sent" were one stage wearing two hats. `lib/commercial/opportunities/kanban-columns.ts`
now owns BOTH directions (tuple→column, column→tuple) — that mapping had been
copy-pasted into four places and had already drifted.

Board + Move-to menus read: **Qualifying · Request for Proposal · Estimating ·
Proposal · Closed Won · Closed Lost | Pre-Construction · In Progress ·
Billing**. Closed sits between the lanes. Follow-Up / "Not sent yet" render as
tags on cards inside the merged Proposal column.

`?status=` now names a COLUMN key (raw statuses still resolve, for old links).

Deliberately NOT columns: `proposal_pending_approval` (lives on the proposal
record — the Kim→Brendan sign-off, not a deal stage) and `follow_up` (a state
of a sent proposal). 12 tests pin the column map against the sub-status
whitelist.

## DONE (committed + pushed)
- Remove Bid low/high (both forms) · RFP defaults today · remove tax exemption (preserve existing) · Alternate→Qualifications · proposal input glitch (React 19 form-reset on autosave) · **Cost→Transactions** nav labels + heading · **auto-title** (MM-DD-YYYY Builder - Client - Street) · **Teams feature** (Settings CRUD + data + account assignment; migration 122).
- **Already existed (no build needed):** global All-Active-Projects list (`/commercial/projects`) · the entire POST-contract status tree.
- **Statuses** — flattened at the display layer (see the section above). Closed Won / Closed Lost relabelled + repositioned. Search bar clear/close (×). Proposal back-arrow returns to the Proposals list.

## MIGRATIONS TO PASTE
- _None outstanding._ (122 Teams applied by Karan 2026-08-11.)

## AWAITING KARAN'S SPECIFICS
- **Brendan sign-offs** "weird" — what specifically (request flow / buttons / notification)? Most likely the login flow (he had to "put together first+last").
- Katie: #3 typo, #8 $8k proposal, F2 submittal send.

## NEXT (buildable, not started) — in build order
1. **Opportunity page tabs by phase** — now unblocked (the pre/post split exists). Pre: Proposals, Documents · Post: Submittals, Invoices, Work Orders, Change Orders, AIA, P&L, Closeout & Warranty, Transactions.
2. **New-opportunity slim form** for a known account (address · name · contact · team + inline add-new-contact). Teams shipped, so this is unblocked too.
3. **Shared IDs finish** — PROJ-#### on won deals · WO-#### · TRANS-#### (ACC/OPP/PROP/INV already exist).
4. **Proposals batch** — revision lifecycle (no R# until after first client send, lock at send) · Bid Set → intro paragraph · Labor into Inclusions (Custom Time qty×rate; Materials flat) · Proposal→Won logic fix.
5. **Crew role** (big) — scoped login: own opps, WOs, hours, calendar, self clock-in. Opens the PIN kiosk to non-admins.
6. **Work Orders from proposal scope** (biggest) — pick scope items off the won proposal, optional area split, PDF/markup upload, multiple WOs per project, unassigned-scope indicator.
7. **Consistency sweep** — IDs/labels/terminology.
