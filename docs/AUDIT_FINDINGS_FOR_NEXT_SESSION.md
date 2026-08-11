# Audit findings — for the next session (2026-08)

Direct sweep of everything shipped today + the same **classes** of bug elsewhere. **No fixes applied** — this is the to-do list. Ordered by severity. Each has a file:line + what to do.

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

## 📋 Still to BUILD (from the meeting — see COMMERCIAL_MEETING_PLAN_2026_08.md)
Display-layer status flatten (RFP column · single Proposal column + Follow-Up tag · pre/post picker split — NO data migration needed) · **Work-Orders-from-proposal-scope builder** (+ PDF upload · multiple WOs · unassigned-scope) · **Crew role** · shared IDs finish (PROJ/WO/TRANS) · new-opp slim form for existing builders + inline new-contact · proposals batch (revision lifecycle · Bid-Set→intro · Labor-into-Inclusions · Proposal→Won logic).
