# Audit findings (2026-08)

Direct sweep of everything shipped + the same **classes** of bug elsewhere.

> **STATUS 2026-08-11:** items **1–4, 6, 8, 9, 10, 15, 17 are FIXED and pushed.**
> Two further audit passes on the status flatten found 10 more (incl. two money
> bugs) — also fixed. See "FIXED" at the bottom for the full list and commits.
> What genuinely remains: **#5** (a decision), **#7**, **#11**, **#12**, **#13**,
> **#14**, plus the blocked items.

---

## 🔴 HIGH — same class as bugs we fixed today, still live elsewhere

### 1. Autosave form-reset (React 19) — 3 MORE components have the exact bug we fixed on the proposal editor
We fixed `autosave-proposal-form.tsx` (React 19 auto-resets a `<form action>` after the action resolves, wiping half-typed uncontrolled inputs mid-autosave). The **same pattern is live** in:
- `components/commercial/autosave-form.tsx` (L113 `<form action={wrappedAction}>` + L55 `requestSubmit()`) — the generic autosave wrapper (used on account/deal edit surfaces).
- `components/commercial/autosave-proposal-name.tsx` (L80 `el.form?.requestSubmit()`, uncontrolled `defaultValue` L97) — the **proposal name** field; will glitch/reset while typing a name.
- `components/commercial/account-inline-card.tsx` (L68 `requestSubmit()` + L79 `action={action}`) — account inline edit cards.
- **Fix (same as the proposal one):** in the debounced fire, call the server action **directly** with `new FormData(form)` instead of `requestSubmit()`, drop the `<form action=>` prop, and `onSubmit={(e)=>e.preventDefault()}`. See the committed fix in `autosave-proposal-form.tsx` for the exact shape.

### 2. `/proposal/new` CREATES a proposal on GET render → browser-back makes a DUPLICATE
`app/commercial/accounts/[id]/deals/[dealId]/proposal/new/page.tsx` — the default async page component calls `createProposal(...)` (L85) in render, then `redirect()`s (L161). Visiting the URL = a mutation. **Pressing browser-back** (or refresh) re-renders it → **creates another proposal** and redirects to it. This is a mutation-on-GET anti-pattern and a likely source of "why do I have extra proposals."
- **Fix:** convert creation to a POST/server-action (button/form) instead of on-render, OR guard with an idempotency token so a re-render can't duplicate.

---

## 🟠 MEDIUM — side effects of today's meeting changes + Teams gaps

### 3. Removing Bid low/high starves the weighted-pipeline KPI
`lib/commercial/opportunities/db.ts:382 weightedPipelineCents` derives from `bid_value_low/high`. We removed those fields from both create forms, so **new opps have no bid → weighted pipeline = 0 / "bid range" shows "—"** for every new deal. The dashboard "weighted pipeline" + bid displays quietly go empty.
- **Decide:** remove the weighted-pipeline/bid KPIs, or repoint them to the **proposal total** (pricing lives there now).
- Related: the create actions still have **dead bid validation** ("Bid low is not a valid dollar amount" redirects) for the now-removed fields — `app/commercial/opportunities/page.tsx:322-325` + `accounts/[id]/page.tsx` deal-edit. Clean up.

### 4. Opp "Account's team (default)" is misleading — null is never resolved to the account's team
`accounts/[id]/page.tsx` NewDealForm Team `<select>` shows "Account's team (default)", but selecting it stores `team_id = null`, and **nothing resolves a null opp team → the account's team** (no fallback in `projects/db.ts` or anywhere). So a deal reads "default" but actually has no team.
- **Fix:** either resolve `opp.team_id ?? account.team_id` wherever a deal's team is shown/used, or change the label to "— No team —".

### 5. Assigning a team to an account only sets `team_id` — it does NOT populate the role-based assignments
The account Team tab "Assigned team" selector sets `commercial_accounts.team_id`, but the team's members are **not** written into `commercial_account_assignments`. Anything that reads the account's PM/sales-rep/foreman from assignments won't see the team's people.
- **Decide:** should "assign a team" also expand into `commercial_account_assignments` (so role-based lookups work), or is the `team_id` display enough? (Karan's ask was "add a Team rather than individual members" — likely wants the members to actually apply.)

### 6. No way to CHANGE a deal's team after creation
Opp `team_id` is only set on the new-deal form. There's no edit-opp-team UI. Add one to the deal drill-in / edit sheet.

---

## 🟡 LOW — polish, consistency, hardening

### 7. Cost→Transactions terminology is half-done
Renamed the tab/mini-card/heading to "Transactions", but the tool still says **"Log a purchase / receipt"** (`costs-tool.tsx:494`), uses `purchase` terminology throughout, the URL key is still `dt=costs`, and the Files category label is "Receipt". Finish the sweep for consistency (Karan's "everything consistent" bar). Also still owed: **`TRANS-####` record IDs** on transactions.

### 8. Teams data layer isn't paginated
`lib/commercial/teams/db.ts` — `listTeams`, `getTeam`, `listAssignableUsers` and the `.in("team_id", …)` member queries have no `paginateAll`/tiebreak. Fine for small teams, but `listAssignableUsers` (all profiles with access) and the member `.in()` could hit Supabase's silent 1000-row cap at scale. Add `paginateAll` + `.order("id")` for safety.

### 9. A team can end up with no admin
`updateTeamMember`/`removeTeamMember` — removing the member who is `is_team_admin` leaves the team **admin-less** with no prompt to re-designate. Consider blocking removal of the last admin, or auto-flagging another member.

### 10. RLS on the new `commercial_teams` tables
Confirm migration 122's `commercial_teams` + `commercial_team_members` have the same RLS posture as the other `commercial_*` tables (they're accessed via the service-role `commercialDb()`, but verify there's no gap vs. how the rest of the schema is protected).

### 11. Auto-title SSR flash + non-input-event addresses
`components/commercial/auto-opportunity-title.tsx` renders `value=""` on SSR, then composes in `useEffect` on mount → brief empty flash. Also, it listens for `input` events on `client_name`/`property_street`; if the address is ever set by a custom picker that doesn't emit `input`, the title won't update. Minor.

### 12. Search palette — two × buttons adjacent
Added a clear-text × (when query) + an always-on close × next to the Esc hint. Verify they don't look cramped on mobile / read as one control.

### 13. tax_exempt is orphaned (informational)
Removed from the account UI; the column + type remain. No invoice/tax logic reads `account.tax_exempt` (verified), so it's safe — but existing exempt accounts keep the flag with no way to change it. Note only.

---

## ⛔ BLOCKED — need info before they can be built/fixed
- **Brendan sign-off** — the exact screen where it forced "first + last name" (login/first-time-setup flow most likely; all name fields we found are single free-text).
- **Katie:** #3 typo (which screen) · #8 "$8,000 auto-created proposal" (real Proposal row vs the deal's "Bid estimate"; fresh vs demo account) · **F2** (send submittals from the CC, or is mark-as-Sent enough).
- **Stephanie:** proposal page order.

---

## ✅ Already fixed today (context — DON'T re-audit/redo)
Time-off feature (mark-off + email + crossed-out + hours-log scheduled-vs-worked + KPI + copy-week confirm) · orphan-delete cascades (deal/account → jobs/invoices) · 1-day/1-hour/10-min crew reminders · Katie B1/U1/U2/U3/U4/F1 · Cost→Transactions labels · auto-title · **Teams** (Settings CRUD + account + opp assignment; **migration 122 applied**) · search-bar × buttons · proposal back-button (new proposals return to the Proposals list) · Closed Won/Lost labels.

---

## 🟠 ROUND 2 — additional findings

### 14. The two "New opportunity" forms have DRIFTED apart
The **account** new-deal form (`accounts/[id]/page.tsx` NewDealForm) got auto-title + a **Team** field + **RFP-defaults-today**. The **pipeline** "New opportunity" sheet (`opportunities/page.tsx`, plain `<input name="title">` at L1588) did **not** — it has no auto-title, no Team selector, no RFP-default (no RFP field at all). So creating a deal from the pipeline gives a different, thinner form than from the account.
- **Fix:** bring the pipeline sheet up to parity (auto-title via `AutoOpportunityTitle`, Team `<select>`, RFP-received default), or route both to one shared form component. (The slim-form work in the plan should consolidate these.)

### 15. `/proposal/new` is the ONLY create-on-GET page — the other `/new` pages are safe
Verified for completeness: `opportunities/new` (pure redirect), `invoices/new` (validate + redirect), `accounts/new` + `products/new` (real `<form action>` = POST). So finding #2 is isolated to the proposal flow — good, one place to fix.

### 16. CORRECTION to #10 (RLS) — downgrade to non-issue
The other `commercial_*` tables (e.g. `commercial_account_assignments`, migration 021) do **not** enable RLS — they rely on service-role access via `commercialDb()`. The new `commercial_teams` tables follow the same pattern, so there's **no RLS gap**. Disregard #10.

### 17. Statuses display-layer flatten — now SHIPPED by the parallel session (commit 7253b21)
`lib/commercial/opportunities/kanban-columns.ts` now owns the tuple↔column mapping; board reads the six pre-contract stages; Follow-Up / Pending-Approval render as tags, not columns. **Remove "display-layer status flatten" from the still-to-build list.** Worth a quick verify that all four old copy-pasted column maps were actually replaced by the new single source (the commit says they'd drifted).

---

## 🟠 ROUND 3 — additional findings

### 18. `CommercialOpportunity` type is MISSING `team_id` — the account type has it, the opp type doesn't
Migration 122 added `team_id` to **both** `commercial_accounts` AND `commercial_opportunities`, and the opp create mutation writes it (`opportunities/mutations.ts:65` input field + L160 insert). But the `CommercialOpportunity` **TypeScript type** in `lib/commercial/opportunities/db.ts` was never given a `team_id` field (grep for `team_id` in that file returns nothing). The account type WAS updated (I added `team_id: string \| null` to `CommercialAccount`), so the two drifted.
- **Why it compiles today:** nothing yet *reads* `opp.team_id` in typed code, so `tsc` stays green. The runtime data has it (the list queries use `.select("*")`, so the column IS returned).
- **Why it bites next:** the moment the next session builds the opp-team display / resolves `opp.team_id ?? account.team_id` (findings #4 + #6), `opp.team_id` is a **type error** — the field they need to read isn't on the type.
- **Fix:** add `team_id: string | null;` to the `CommercialOpportunity` type. One line; do it alongside #4/#6.

### 19. `?back=` is NOT an open redirect — verified safe
For completeness (this is a redirect built from a query param, which is the classic open-redirect shape): `proposal/new/page.tsx:42` and `proposal/[proposalId]/page.tsx:929` both **whitelist** `back` to the exact literal `"/commercial/proposals"` (`sp.back === "/commercial/proposals" ? … : ""`). Any other value is dropped. So a crafted `?back=https://evil.com` can't redirect anywhere. **No action** — noting it so the next session doesn't "fix" a non-bug or copy an unsafe pattern; if they add more back-targets, keep the strict-equality whitelist (don't switch to `startsWith("/")`, which re-opens `//evil.com` protocol-relative redirects).

### 20. New Teams/auto-title code is clean — verified
No `TODO`/`FIXME`/`@ts-ignore`/`eslint-disable` in `lib/commercial/teams`, `components/commercial/auto-opportunity-title.tsx`, or `app/commercial/settings/teams`. Noting so the next session doesn't re-sweep these; the open Teams items are the behavioral ones already listed (#5 assignments, #6 change-team, #8 pagination, #9 last-admin).

---

## 🟠 ROUND 4 — cascade / restore integrity

### 21. Deal-delete tears down field-ops jobs, but deal-RESTORE doesn't rebuild them — asymmetric undo
`deleteCommercialOpportunity` (`opportunities/mutations.ts:392-397`) cascades: it calls `cascadeDeleteJobsForOwner` which **soft-deletes the WO, cancels future crew assignments, and reopens a sent WO to draft**. But `restoreCommercialOpportunity` (L438-460) only cascade-restores **invoices** (`commercial_invoices` in the ±2s window) — it does **nothing** for field-ops jobs. So the undo-toast after deleting a deal brings the deal + its invoices back, but the **work order stays deleted and the crew assignments stay cancelled**. Alex clicks "Undo," thinks everything's back, and the scheduled crew silently isn't.
- **Fix:** give restore a `cascadeRestoreJobsForOwner` mirror (re-open the jobs deleted in the same window; ideally re-instate the cancelled assignments). Same batch-window approach the invoice restore uses, or the batch-id tag the code comment already wishes for (L436-438).

### 22. Deal-delete does NOT cascade to `commercial_project_purchases` (transactions) — latent zombie-cost risk
The delete cascade covers invoices + jobs but **not purchases/transactions**. A deleted deal's purchase rows keep `deleted_at = null`. Today this is **masked** — every viewer/aggregator (`listPurchasesForProject(oppId)`, `purchaseTotalsByOpp(ids)`, the dashboard/job-costs report) drives off an **active-opp id list** (`listCommercialOpportunities({})` filters `deleted_at`), so a dead deal's costs are never fetched or summed. But it's a fragility, not a guarantee: the moment anyone adds a report that sums `commercial_project_purchases` directly (all-purchases, or by date range) without inner-joining the parent opp's `deleted_at`, **zombie costs from deleted deals leak into company P&L**. Invoices don't have this problem *because* they're cascaded/tombstoned.
- **Fix (consistency):** mirror the invoice cascade for purchases — tombstone the deal's purchases on delete, restore them in the same window (and see #21). Cheap insurance vs. a P&L bug that'd be near-impossible to spot later.

### 23. Verified SAFE: global proposals list already filters deleted-deal/account orphans
For completeness (proposals aren't cascaded on deal-delete either): the global proposals page **defensively** `!inner`-joins the deal + account and drops any row whose `opportunity.deleted_at` or `account.deleted_at` is set (`app/commercial/proposals/page.tsx:247-267`). So orphaned proposals don't surface there. **No action** — but the underlying proposals still aren't tombstoned, so treat #22's "mirror the cascade" as covering proposals too if the next session standardizes cascade behavior.

---

## 📋 Still to BUILD (from the meeting — see COMMERCIAL_MEETING_PLAN_2026_08.md)
Display-layer status flatten (RFP column · single Proposal column + Follow-Up tag · pre/post picker split — NO data migration needed) · **Work-Orders-from-proposal-scope builder** (+ PDF upload · multiple WOs · unassigned-scope) · **Crew role** · shared IDs finish (PROJ/WO/TRANS) · new-opp slim form for existing builders + inline new-contact · proposals batch (revision lifecycle · Bid-Set→intro · Labor-into-Inclusions · Proposal→Won logic).


---

## ✅ FIXED + PUSHED (2026-08-11)

| # | Item | Commit |
|---|---|---|
| 1 | Autosave form-reset in `autosave-form`, `autosave-proposal-name`, `account-inline-card` — all three now call the action directly instead of `requestSubmit()` | `0c537e0` |
| 2 | `/proposal/new` duplicating on browser-back — `findReusableDraftProposal` idempotency guard | `0c537e0` |
| 3 | Weighted-pipeline / bid / funnel / Top-5 counting bid-less deals as ZERO — now falls back to the deal's current proposal total (`listCurrentProposalTotalByOpp`) | `79086d9` |
| 4 | "Account's team (default)" storing null with no fallback — `getEffectiveOwnerTeam` makes the inheritance real; option names the inherited team | `3428f8a` |
| 6 | No way to change a deal's team after creation — editable Team row on the deal's Info tab | `3428f8a` |
| 8 | Teams queries unpaginated (`listAssignableUsers` could silently drop members past 1000) | `a724d85` |
| 9 | A team could end up admin-less — auto-promotes the longest-standing member instead of blocking the removal | `a724d85` |
| 10 | RLS — confirmed non-issue (matches every other `commercial_*` table) | — |
| 15 | `/proposal/new` confirmed the only create-on-GET page | — |
| 17 | Status display-layer flatten | `7253b21` |

**Also found + fixed by the two follow-up audits on the flatten** (`0c537e0`):
`CommercialOpportunity` never declared `team_id` (write-only column) ·
"→ Closed Lost" opened the form on Closed·**WON** so one click booked a loss as
a win · the status picker defaulted to **Qualifying** on every deal (`??` vs
`||`), one click demoting the deal and reverting its proposal to draft · debrief
fields ignored the sub-status select, so choosing Lost rendered the WIN debrief
then failed server-side · **CSV export dropped the filter entirely** for the
rfp/won/lost columns (exported the whole pipeline) · "→ Closed Lost" on a Won
card was a silent dead end · sub-status edits emailed the team "moved status
from Proposal → Proposal" · `columnDbStatusHint("qualifying")` re-introduced the
silent row-drop · "Closed" vs "Closed (post-sale)" label drift.

### Still open, and why
- **#5 (team → assignments)** — needs Karan's call: should assigning a team to
  an account also expand its members into `commercial_account_assignments` so
  role-based PM/rep lookups see them, or is the team_id link enough?
- **#7 / #11 / #12 / #13** — polish (Transactions terminology sweep + TRANS-####
  IDs, auto-title SSR flash, two-× spacing, orphaned `tax_exempt`).
- **#14** — the two New-opportunity forms have drifted; folded into the
  slim-form work in the plan doc.
- Note: the "dead bid validation" in #3 was left in place deliberately — it is
  correct defensive parsing that no-ops when the field is absent, and would be
  live again if the field ever returns.


---

## ✅ ROUND 3 CLOSE-OUT (2026-08-11) — the list is now EMPTY except the blocked items

| # | Item | Commit |
|---|---|---|
| 3 (tail) | Bid low/high removed from the deal EDIT sheet + standalone edit page; dead parsing/validation cleaned from all three actions | `ed95716` |
| 5 | Assigning a team now EXPANDS into `commercial_account_assignments` (Karan: yes). Additive, idempotent, names anyone it couldn't assign | `ed95716` |
| 7 | Transactions rename finished ("Log a purchase / receipt", "Add purchase", "Purchase date", "What was purchased", delete copy) + `dt=transactions` / `?pt=transactions` aliases | `5c63779` |
| 11 | Auto-title SSR flash fixed (seeded on first render) + now listens for `change` as well as `input` so a picker/autofill can't leave it stale | `d30e331` |
| 12 | Palette's two X buttons separated on mobile (the Esc chip that divides them on desktop is hidden there) | `bcc648e` |
| 13 | tax_exempt — see the CORRECTION below | `bcc648e` |
| 14 | The two New-opportunity forms brought to parity (auto-title, Team, RFP-received default) | `d30e331` |
| 21 | `cascadeRestoreJobsForOwner` — Undo now rebuilds the work orders AND un-cancels the crew's future shifts | `805cc70` |
| 22 | Deal-delete tombstones `commercial_project_purchases`; restore brings them back in the same window | `805cc70` |

**Also fixed, found while working the list:**
- **The account Team tab was DEAD CODE.** `?tab=team` fell into a legacy remap to Documents, so the whole "assign a team to this customer" flow was unreachable — and the assign action redirected to `?tab=team`, landing the user on Documents with no feedback. (`ed95716`)
- **The tax-exemption card was still on the account DETAIL page.** The 2026-08 removal covered the create and edit forms only. (`bcc648e`)
- **Create-mode status picker offered post-contract stages** (Pre-Construction / In Progress / Billing) on a brand-new bid. Now one flat pre-contract Stage select: Qualifying · Request for Proposal · Estimating · Proposal. (`d30e331`)
- **Pre/post-contract deal tabs** split (meeting item). Pre = Overview · Proposals · Documents; post = the full delivery set. (`5c63779`)
- **Shared record IDs** PROJ-#### / WO-#### / TRANS-#### all deriving from the deal's number, with 7 tests pinning the shared-suffix property. (`8d133aa`)

### ⚠️ CORRECTION to #13
The note said "No invoice/tax logic reads `account.tax_exempt` (verified safe)".
**It does** — `AccountProjectsTab` defaults the deal invoice's tax rate to 0% for
an exempt customer. That behaviour is correct and is NOT invisible (the invoice
builder already prints why), but the claim that nothing reads it was wrong, and
acting on it without checking would have been a silent mis-bill.

### Still open
Only the ⛔ BLOCKED items above (Brendan's screen · Katie #3/#8/F2 · Stephanie's
page order) and the STILL-TO-BUILD list: **Work-Orders-from-proposal-scope
builder**, **Crew role**, and the **proposals batch** (revision lifecycle ·
Bid-Set→intro · Labor-into-Inclusions · Proposal→Won logic).
