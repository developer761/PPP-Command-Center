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

## DONE (committed + pushed)
- Remove Bid low/high (both forms) · RFP defaults today · remove tax exemption (preserve existing) · Alternate→Qualifications · proposal input glitch (React 19 form-reset on autosave) · **Cost→Transactions** nav labels + heading · **auto-title** (MM-DD-YYYY Builder - Client - Street).
- **Status analysis:** POST-contract tree already matches Karan's spec exactly. PRE-contract needs the flatten (RFP→top-level, Closed Won/Lost split) + a decision on where Follow-Up & Proposal-Pending-Approval go — awaiting Karan's specifics + a migration map for review.

## AWAITING KARAN'S SPECIFICS
- **Statuses** (the "do together" item): confirm the flat pre-contract list + where Follow-Up / Proposal-Pending-Approval map → then I write the migration + do the pre/post UI split.
- **Search bar** "weird" — what specifically (results/ranking/⌘K)?
- **Brendan sign-offs** "weird" — what specifically (request flow / buttons / notification)?
- Katie: #3 typo, #8 $8k proposal, F2 submittal send.

## NEXT (buildable, not started)
phase tabs (needs status split) · new-opp slim form for existing builder (needs Teams) · shared IDs + TRANS records · WO-from-scope builder · proposal revision lifecycle + Labor-into-Inclusions + Won-logic · global projects list · Teams · Crew role · consistency sweep.
