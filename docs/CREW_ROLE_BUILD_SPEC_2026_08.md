# Crew Role — scoped self-service views · BUILD SPEC (2026-08)

**For the parallel build session.** This is a complete, self-contained spec.
The verification session that wrote this is **NOT building any of it** — no
overlap. It will **recheck the finished work** against this doc afterward.

---

## 0. Why this exists (what's already shipped, and what's wrong)

Commit `57278b1` shipped the Crew role. Its **security architecture is correct
and must be kept**: a deny-by-default allowlist enforced once in
`app/commercial/layout.tsx`, reading the `x-pathname` header stamped by
`proxy.ts`. Do **not** rip that out.

But the feature is **functionally broken**, and the fix is this spec:

- The crew landing (`/commercial/crew`) shows 4 tiles that link to
  `/commercial/field-ops/{schedule,calendar,hours}` + `/clock-station`.
- Those three field-ops pages are **company-wide admin pages** — each has its
  OWN admin gate (`if (!isAdmin) redirect("/commercial")`). So a crew login is
  bounced right back. **3 of the 4 tiles are dead links.** Only clock-station
  works.
- The commit's claim that these pages are "per-employee by construction" is
  **false** — they show every employee's hours and the whole company calendar.
  (They don't leak, only because they admin-gate. But they deliver nothing.)
- **Root blocker:** `commercial_employees` has **no link to a login account**
  (only a nullable `email`). There is no way to know which employee a logged-in
  crew user *is*, so no view can be scoped to "their own" anything.

**Goal:** a crew member logs into their own admin-provisioned account and sees
ONLY their own work — their schedule, their hours, the work orders/jobs they're
assigned to — and can clock in/out (personal login OR shared-kiosk PIN). Nothing
else.

---

## 1. Confirmed decisions (from Karan, 2026-08)

1. **Crew logins are separate accounts admins provision** in Settings → Access
   (email + password, Commercial-only — the existing provisioning flow).
2. **The login → employee link is an explicit admin choice**, made when granting
   the crew role: the admin picks which `commercial_employees` record this login
   IS. **Not** email auto-match (fragile — employee email is nullable / may
   differ). One employee ↔ at most one login.
3. **Scope = only what they're assigned.** "Their jobs" = the work orders / jobs
   they have crew assignments on. "Their hours" = their own clocked/approved
   time. "Their schedule" = their own shifts. No company totals, no other
   crew, no money/P&L, no proposals, no accounts.
4. **Clock in/out** works two ways, both kept: (a) their **personal login**
   (they're already identified → clock without re-entering a PIN, or confirm
   with PIN — see §5), and (b) the **shared kiosk** (`clock-station`) where they
   pick their name + enter their 4-digit PIN. The kiosk already opens to crew.

---

## 2. Data model — migration 125

Add the login link to employees. **New migration `125_commercial_employee_user_link.sql`.**

```sql
-- Link a field-ops employee to a Commercial login account (crew self-service).
-- Nullable: most employees never get a login; a login is optional and set by an
-- admin in Settings → Access when granting the crew role.
alter table public.commercial_employees
  add column if not exists user_id uuid;

-- At most ONE employee per login (a login is one person). Partial unique so the
-- many NULLs don't collide. NOT a hard FK to auth.users — this codebase keys to
-- auth user ids by convention elsewhere (see commercial_user_roles.user_id) and
-- avoids cross-schema FKs; match that convention.
create unique index if not exists commercial_employees_user_id_key
  on public.commercial_employees (user_id)
  where user_id is not null;
```

- Add `user_id: string | null` to the `CommercialEmployee` type and to
  `EMPLOYEE_COLS` in `lib/commercial/field-ops/employees.ts` (currently line
  33–56). Without adding it to the SELECT list the column won't come back.
- **Edge:** granting crew to a login that's already linked to employee A, then
  linking it to employee B, must clear A first (the partial unique index will
  otherwise 23505). Handle in the link mutation (§4), not by catching the error.

---

## 3. Auth resolution helper (the one choke-point)

Add to `lib/commercial/crew-access.ts` (keep everything already there):

```ts
/** The employee record a login IS, or null. The single source of truth every
 *  scoped crew view calls first. */
export async function getEmployeeForUser(userId: string): Promise<CommercialEmployee | null>
```

- Query `commercial_employees` by `user_id = userId`, `active = true`,
  `deleted_at is null`. Return null if none.
- Every scoped page (§5) calls this. If it returns null for a crew-only user
  (crew role granted but no employee linked yet), the page renders a friendly
  **"Your login isn't linked to a crew member yet — ask an admin"** empty state,
  NOT a crash and NOT a redirect loop. This is a real state between "granted
  crew" and "picked the employee."

---

## 4. Settings → Access — link UX

File: `app/commercial/settings/access/page.tsx` (the crew section is ~line
194–216, `toggleCrewAction` ~line 53).

**Today:** a per-user toggle that only sets/clears the crew role.

**Change to:** when an admin turns crew ON for a user, they must also pick the
employee. Two sensible shapes — pick one:

- **Preferred:** a searchable employee `<select>` (reuse the searchable-combobox
  component per the >10-items rule) shown next to each user; "Grant crew"
  is enabled once an employee is chosen. Store the link + set the role in one
  action.
- Minimum: keep the toggle, and on enable, reveal the employee picker inline;
  don't finalize the role until an employee is chosen.

New/changed mutations in `lib/commercial/crew-access.ts`:

```ts
// Set (or clear with null) the employee this login maps to. Clears any prior
// employee holding this user_id first (partial-unique-safe). Audit-logged.
export async function linkEmployeeToUser(userId, employeeId | null, actorUserId)
```

- `setCrewRole` stays, but the Access UI should call link + role together so an
  admin can't leave a crew login unlinked by accident (the §3 empty state is the
  safety net, not the happy path).
- **Revoking crew** should offer to also clear the employee link (ask, don't
  force — they may re-grant later).
- Show the linked employee's name on each crew row so an admin sees the mapping
  at a glance. Warn if two different logins somehow point at the same employee
  (shouldn't happen with the unique index, but surface it).

---

## 5. The scoped crew surfaces

Replace the 3 dead tiles. New crew-owned routes under `/commercial/crew/*` so
they're unambiguously the crew's (and easy to allowlist). Each page:
`getUser` → `getEmployeeForUser` → if null, the §3 empty state → else scope
every query to `employee.id`.

### 5.1 `/commercial/crew` (landing) — KEEP, re-point tiles
Four big touch targets (44px+), one-bar-of-signal friendly:
**My Schedule · My Hours · My Jobs · Clock in/out.** Remove the links to
`/commercial/field-ops/{schedule,calendar,hours}`.

### 5.2 `/commercial/crew/schedule` — My Schedule
- Their upcoming shifts: `commercial_assignments` where `employee_id = me`,
  `status != 'cancelled'`, `work_date >= today`, ordered by date.
- For each: date, job name (via `job_id → commercial_jobs`), scheduled
  start/end + hours, the work note, and their clock status for that day.
- Show their time-off / days marked off too (`commercial_absences` for me).
- **New data fn** (company-wide `getMonthOverview`/`getDaySchedule` are NOT
  per-employee): `listMyUpcomingShifts(employeeId, fromIso, toIso)` in
  `lib/commercial/field-ops/schedule.ts`. Paginate + `.order` tiebreak.

### 5.3 `/commercial/crew/hours` — My Hours
- Their own clocked/approved actuals: reuse the SAME source as `getHoursLog`
  (`commercial_time_entries` for me) but **scoped to `employee_id = me`**.
  `getHoursLog(start,end)` is company-wide — add an optional
  `employeeId?` filter, or a thin `getMyHoursLog(employeeId,start,end)` wrapper.
- Show scheduled-vs-worked per week, broken down by job/WO — their number only.
  No company totals, no approve/edit controls.

### 5.4 `/commercial/crew/jobs` — My Jobs
- The work orders / jobs they're on: distinct `job_id` from their assignments →
  `commercial_jobs` → the deal + WO. Show job name, site city, their next shift
  on it, and (optional) a read-only view of the WO scope lines that are on the
  sheet the crew was handed (`commercial_work_orders.scope_line_item_ids`).
- **Read-only.** No pricing, no proposal $, no account P&L. Just "what am I
  painting and where."

### 5.5 Clock in/out
- Keep `clock-station` (shared kiosk, PIN) — already crew-aware.
- Personal clock: since the login is already the identified employee (§3), the
  crew landing's "Clock in/out" can clock **without** re-entering a PIN — OR
  require the PIN as a buddy-punch guard (Karan's call; default: personal login
  = no PIN needed, kiosk = PIN, mirroring "prove it's you on a shared device").
  Reuse the kiosk-clock API path; pass the resolved `employee.id` from the
  session instead of a picked id. The `kiosk-clock` route already verifies PIN
  for the shared path — keep that; add a session-authenticated path that trusts
  `getEmployeeForUser`.

---

## 6. Allowlist changes (`lib/commercial/crew-access.ts`)

`CREW_ALLOWED_PREFIXES` becomes:

```ts
const CREW_ALLOWED_PREFIXES = [
  "/commercial/crew",                        // landing + all /crew/* scoped views
  "/commercial/field-ops/clock-station",     // shared kiosk (PIN)
];
```

- **Remove** `/commercial/field-ops/{schedule,calendar,hours}` — those are the
  company-wide admin pages; crew get their scoped `/commercial/crew/*` versions
  instead. (This also means the segment-boundary match now covers all `/crew/*`
  children with the single `/commercial/crew` prefix — keep the boundary test.)
- Keep `CREW_HOME = "/commercial/crew"`; it's still in the allowlist (no loop).
- Any API routes the scoped pages call (personal clock) must ALSO be reachable —
  the allowlist is for `/commercial/*` page routes; API routes under
  `/api/commercial/*` are gated by their own handlers, so the personal-clock API
  must check `getEmployeeForUser` itself (don't rely on the layout).

---

## 7. Edge cases — handle ALL of these

1. **Crew granted, no employee linked yet** → friendly empty state on every
   `/crew/*` page (§3). No crash, no loop.
2. **Employee linked, then deactivated** (`active=false`) → `getEmployeeForUser`
   returns null (filter on active) → empty state. Their login still works, just
   shows "ask an admin."
3. **Login deactivated** (`profile.is_active=false`) → existing layout gate
   already bounces them (`?error=access_revoked`). No change.
4. **Admin also holds crew role** → `isCrewOnlyUser` already returns false →
   unrestricted. Unchanged. (Don't scope an admin's field-ops views.)
5. **Two logins point at one employee** → prevented by the partial unique index;
   the link mutation must surface a clear error, not a 23505 dump.
6. **One login re-pointed A→B** → clear A's `user_id` first (§2 edge).
7. **Crew member with zero upcoming shifts / zero hours** → empty states that
   read like a person wrote them ("No shifts scheduled yet"), not blank cards.
8. **Kiosk PIN vs personal clock double-punch** → clocking from personal login
   and the kiosk are the same `employee_id`; the existing clock idempotency
   (open-punch guard in `clock.ts`) already covers "already clocked in." Verify
   it treats both sources as the same person (it keys on employee_id — should be
   fine, but test it).
9. **Direct-URL probing** → a crew user typing `/commercial/page` (dashboard),
   `/commercial/accounts`, `/commercial/invoices`, `/commercial/reports`,
   `/commercial/settings` must all redirect to `CREW_HOME`. The allowlist
   already does this; add a test asserting a representative denied path.
10. **Personal-clock API called by a non-crew or unlinked user** → the API
    resolves `getEmployeeForUser`; null → 403. Never trust a client-sent
    employee_id on the session path.
11. **Mobile** — crew are on job sites on phones: 44px targets, single column,
    works at 375px, no iOS zoom on any input.
12. **Timezone** — all "today"/"this week" use `todayEtIso()` (ET), never UTC.
13. **Pagination** — any new list query (`listMyUpcomingShifts`, my-hours)
    paginates with an `.order("id")` tiebreak (crew with a long history).

---

## 8. File-by-file task list

| File | Change |
|---|---|
| `supabase/migrations/125_commercial_employee_user_link.sql` | **new** — `user_id` col + partial unique index (§2) |
| `lib/commercial/field-ops/employees.ts` | add `user_id` to type + `EMPLOYEE_COLS`; keep PIN fns |
| `lib/commercial/crew-access.ts` | add `getEmployeeForUser`, `linkEmployeeToUser`; trim `CREW_ALLOWED_PREFIXES` (§6) |
| `app/commercial/settings/access/page.tsx` | employee picker when granting crew; show linked name; link+role in one action (§4) |
| `app/commercial/crew/page.tsx` | re-point the 4 tiles to `/commercial/crew/*` (§5.1) |
| `app/commercial/crew/schedule/page.tsx` | **new** — My Schedule (§5.2) |
| `app/commercial/crew/hours/page.tsx` | **new** — My Hours (§5.3) |
| `app/commercial/crew/jobs/page.tsx` | **new** — My Jobs (§5.4) |
| `lib/commercial/field-ops/schedule.ts` | add `listMyUpcomingShifts(employeeId, from, to)` |
| `lib/commercial/field-ops/hours-log.ts` | add optional `employeeId` filter (or `getMyHoursLog`) |
| `app/api/commercial/field-ops/kiosk-clock/route.ts` (or a new personal-clock route) | session-authenticated clock path via `getEmployeeForUser` (§5.5, §7.10) |
| `__tests__/commercial/crew-access.test.ts` | extend: `getEmployeeForUser` null → empty state; denied dashboard/accounts/settings paths; the personal-clock 403 |

**Do NOT touch** the company-wide `/commercial/field-ops/{schedule,calendar,hours}`
pages — they stay admin-only. The crew get their own scoped `/crew/*` versions.

---

## 9. Definition of done

- A provisioned crew login, linked to an employee, sees My Schedule / My Hours /
  My Jobs with **only their own** data, and can clock in/out (personal + kiosk).
- Every non-allowed `/commercial/*` route redirects a crew login to `/crew`.
- Crew granted-but-unlinked shows the friendly empty state everywhere (no loop).
- No company data (other crew, money, P&L, proposals, accounts) reachable by any
  crew-only login — verify by trying to load each and getting bounced.
- Migration 125 written + applied. `tsc --noEmit` clean, full test suite green,
  production build green.
- Mobile-perfect at 375px; ET dates; paginated lists.

---

## 10. What the recheck (verification session) will do after

- Adversarially confirm **no company data leaks** to a crew-only login (try
  every office route + the personal-clock API with a forged/other employee_id).
- Confirm the empty state, not a crash/loop, for granted-but-unlinked.
- Confirm the allowlist trim didn't accidentally deny a needed `/crew/*` child.
- Confirm scoping queries actually filter by `employee.id` (not company-wide).
- Confirm migration 125 applied + no drift; tsc + tests + build green.
- Re-run the same "is the claim true?" pass this doc came from — the last commit
  *claimed* per-employee scoping that didn't exist, so every "scoped" claim gets
  checked against the query, not the comment.
