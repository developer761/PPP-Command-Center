# Restructure — Opportunity / Project split + Salesforce-style list view

**Status:** PLAN — no code written yet
**Author:** Karan's Claude session A (2026-08-12)
**Decided with:** Karan, from notes he and Katie wrote + two Salesforce screenshots
**Cross-session:** session B should read this before touching `commercial_opportunities`,
any delivery table, or `app/commercial/accounts/[id]/page.tsx`. See §11.

---

## 1. The decision

Two changes, one restructure.

**(a) Data model — split the sale from the work.**

Karan's sketch, verbatim:

```
Opps          — Opp        | Name   | Owner | Amount | ID
Projects      — Project    | Name   | Owner | Amount | ID | Oppty ID
Transaction   — Transaction| Amount | Date   | ID     | Project ID
```

> "The opp id stays the same through project, cost/transaction looks up to the
> project id. Opp captures sale, project captures work plus related details."

I initially argued for one record with two phases. **That was wrong.** The tell is
that `Projects` carries its *own* Owner and its *own* Amount:

- **Owner differs.** Kim sells it, a PM runs it. One column can't be both, and any
  report grouped by owner is wrong the moment they differ — which is exactly what
  the Opportunity Pipeline Manager report does.
- **Amount differs.** Quoted subtotal ≠ contract value. Collapsing them into one
  field is the root cause of the F1 money bug we already fixed this month (a
  re-quote erasing a signed contract). The split removes the class of bug, not
  just the instance.

**(b) Navigation — opportunity-first, list-first, everything on one page.**

Salesforce-style filterable list → click a row → one page that holds the whole job.
Kanban retires (status advances on its own now, so dragging a card *is* manual
status entry — the thing the auto-advance engine replaced).

**Split the data. Keep one page.** These are not in conflict: `commercial_projects`
is a real table with its own ID/owner/amount, and the UI renders it as the delivery
half of the opportunity page. Nobody navigates to a second record.

---

## 2. What already exists

Checked against the codebase rather than assumed. Most of this is built:

| Requirement | Today |
|---|---|
| List-first opportunities view | ✅ default (`?view=kanban` is opt-in) |
| Status auto-advances from artifacts | ✅ auto-advance engine (2026-08-11) |
| Opportunity page with tabs | ✅ info · debrief · invoices · team · tasks · notes · emails · plans · finishes · files · timeline |
| Opp must attach to an account | ✅ enforced at creation |
| Dashboard on the main page | ✅ `/commercial` |
| `project_number` (YYYY-NNNN) + counter | ✅ migration 046 |
| Journey strip component | 🟡 `deal-journey-strip.tsx` — not a Salesforce path yet |

**Genuinely missing:**

1. `commercial_projects` does not exist. Delivery artifacts hang off the opportunity.
2. The job's home page lives *inside* the account record
   (`/commercial/accounts/<id>?tab=projects&project=<deal>&dt=<tool>`).
   Seven tools live there: Proposals, Change Orders, AIA, Submittals, Closeout,
   Work Order, Transactions.
3. Sidebar advertises company-wide tool lists that duplicate the per-job tools.
4. Account page is not lean.
5. No saved list views; no stage-aware KPIs; no status path bar.

---

## 3. Data model

### 3.1 New table

```sql
create table public.commercial_projects (
  id                    uuid primary key default gen_random_uuid(),
  opportunity_id        uuid unique references public.commercial_opportunities(id) on delete restrict,
  project_number        text,             -- inherited from the opp, NOT re-issued (§8.6)
  name                  text not null,
  owner_user_id         uuid references auth.users(id),   -- the PM. defaults to opp owner
  contract_base_cents   bigint,           -- the agreed figure at award. NOT recomputed (§8.9)
  contract_source       text,             -- accepted_proposal | manual | snapshot  (provenance)
  status                text not null,    -- delivery ladder, see §6.2
  started_at            date,
  substantially_complete_at date,
  closed_out_at         date,
  archived_at           timestamptz,
  created_at            timestamptz not null default now(),
  created_by_user_id    uuid references auth.users(id)
);
```

- `opportunity_id` is **UNIQUE** — enforces 1:1 and makes project creation idempotent
  under a status that bounces (§8.2).
- `opportunity_id` is **NULLABLE** — a T&M job that never had a bid can exist without
  inventing a fake opportunity (§8.14).
- `on delete restrict` — deleting an opportunity that owns a project with invoices on
  it must fail loudly, not cascade money into the void.

### 3.2 The 18 tables that carry an opportunity link

Scanned across all 135 migrations (inline FKs *and* bare `ALTER TABLE ADD COLUMN`,
several of which have no FK constraint at all — noted, worth fixing while we're here):

**Stays on the OPPORTUNITY (the sale):**

| Table | Column | Why |
|---|---|---|
| `commercial_proposals` | `opportunity_id` | the bid itself |
| `commercial_proposal_email_sends` | `opportunity_id` | who the bid went to |
| `commercial_opportunity_attachments` | `opportunity_id` | plans / RFP |
| `commercial_opportunity_notes` | `opportunity_id` | sales notes |
| `commercial_opportunity_tasks` | `opportunity_id` | sales follow-ups |
| `commercial_opportunity_status_log` | `opportunity_id` | sales ladder history |
| `commercial_opportunity_assignments` | `opportunity_id` | sales team |
| `commercial_win_loss_debrief` | `opportunity_id` | outcome of the sale |
| `commercial_opp_finishes` | `opportunity_id` | spec'd as part of the proposal |
| `commercial_account_notes` | `source_opportunity_id` | auto-note from win/loss |

**Moves to the PROJECT (the work):**

| Table | Column | Note |
|---|---|---|
| `commercial_invoices` | `opportunity_id` → `+project_id` | |
| `commercial_change_orders` | `opportunity_id` → `+project_id` | |
| `commercial_aia_applications` | `opportunity_id` → `+project_id` | |
| `commercial_opp_submittals` | `opportunity_id` → `+project_id` | |
| `commercial_work_orders` | `opportunity_id` → `+project_id` | |
| `commercial_closeout_packages` | `opportunity_id` → `+project_id` | |
| `commercial_project_purchases` | `opportunity_id` → `+project_id` | **transactions** — Karan's sketch names this one explicitly |
| `commercial_jobs` | `opportunity_id` → `+project_id` | field-ops; nullable, one-offs have neither |

### 3.3 How to move 872 references without a big-bang rewrite

`opportunity_id` appears **872 times across 75 files**. Rewriting all of them in one
pass is where this goes wrong.

**Approach: add `project_id`, keep `opportunity_id`, forbid drift.**

On each delivery table:

1. `ADD COLUMN project_id uuid REFERENCES commercial_projects(id)`
2. Backfill from the project created for that opportunity
3. **Add a trigger** asserting `opportunity_id = (select opportunity_id from
   commercial_projects where id = project_id)` on insert/update

Because a project's `opportunity_id` never changes after creation, the mirror
**cannot** drift — the constraint makes that a database-level guarantee rather than a
convention someone remembers. Existing queries keep working; new code (transactions,
job-cost reporting, PM-owned views) reads `project_id`.

This is a deliberate denormalisation with an enforced invariant, *not* two sources of
truth. Call sites migrate opportunistically. The trigger is the thing that makes this
safe — **do not skip it.**

---

## 4. Target information architecture

### 4.1 Sidebar

**Keep:** Dashboard · Accounts · Opportunities · Field Ops · Reports · Products ·
Exclusions · Settings

**Remove:** Proposals · Projects · Invoices · and the six Post-Job entries
(Work Orders, Submittals, Change Orders, AIA Billing, Transactions, Closeout).

They are not deleted — they become **saved list views** (§5.2). Kim pins
*Proposals Out*, the PM pins *Active Projects*, Alex pins *This Week*. One list,
different saved filters.

**One exception:** AR / invoice aging moves under **Reports**. "Who owes us money
across every job" is a cross-job question a per-job page structurally cannot answer.

### 4.2 Routes

| Now | After |
|---|---|
| `/commercial/accounts/<a>?tab=projects&project=<d>&dt=<tool>` | `/commercial/opportunities/<d>?tab=<tool>` |
| `/commercial/accounts/<a>/change-orders/<d>` | `/commercial/opportunities/<d>?tab=change-orders` |
| `/commercial/accounts/<a>/aia/<d>` | `/commercial/opportunities/<d>?tab=aia` |
| `/commercial/accounts/<a>/submittals/<d>[/<sid>]` | `/commercial/opportunities/<d>?tab=submittals[&sid=]` |
| `/commercial/accounts/<a>/closeout/<d>` | `/commercial/opportunities/<d>?tab=closeout` |
| `/commercial/accounts/<a>/costs/<d>` | `/commercial/opportunities/<d>?tab=transactions` |
| `/commercial/accounts/<a>/work-order/<d>` | `/commercial/opportunities/<d>?tab=work-order` |
| `/commercial/accounts/<a>/deals/<d>/proposal/**` | `/commercial/opportunities/<d>?tab=proposals[&p=]` |
| `/commercial/post-job/*`, `/commercial/proposals`, `/commercial/projects` | saved views on `/commercial/opportunities` |

**Every old route 308-redirects to its new home.** Not optional — see §8.17–8.22.

### 4.3 Account page (lean)

Header · contacts · tags · documents · **their opportunities** · **their rolled-up
KPIs**. Clicking a row leaves for the opportunity page. **No embedded tools.**

### 4.4 Opportunity page

Status path bar across the top, then tabs:

- **Always:** Overview · Info · Plans & RFP · Proposals · Team · Tasks · Notes ·
  Emails · Files · Timeline
- **Unlock at Closed Won:** Work Order · Submittals · Change Orders · Invoices ·
  AIA · Transactions · Closeout
- **Attendance** stays in Field Ops, surfaced here read-only as *crew hours on this
  job*, linking through. Scheduling must not fork into a per-job silo
  (`project_rux_conventions_and_wo_scheduler`).

Header switches identity at the win: **"Opportunity"** → **"Project · 2026-0117"**,
showing project owner + contract value alongside the sales owner + quoted subtotal.

---

## 5. List view spec

Taken from the two Salesforce screenshots.

### 5.1 Anatomy

- **Saved-view picker** in the title position with a **pin** — the view *is* the page
  identity ("New This Week ▾"), not a filter bolted onto a generic list.
- **Status line** under the title: `50+ items · Sorted by Created Date · Filtered by
  Created Date · Updated 3 minutes ago`. Small, and the reason the view never feels
  like it's hiding something. **Ours gives a true count, never "50+".**
- **Header totals:** record count **and** summed amount (`32 · $268,100.00`),
  recomputed on every filter change.
- **Filter panel**, right side, with individually removable chips.
- **Grouping** with subtotals (the report groups by Owner). Wanted on the list too.
- Search-within-list · column chooser · per-row action chevron · printable view.

### 5.2 Saved views

**Per-user by default; admins can publish a shared view.** A shared view that anyone
can edit means one person silently changes everyone's screen.

Ship with: *All Open* · *My Opportunities* · *New This Week* · *Proposals Out* ·
*Awaiting Approval* · *Won — Not Started* · *Active Projects* · *Billing* ·
*Needs Debrief*.

The last four are project-side — i.e. the retired sidebar entries, reborn.

### 5.3 Columns

Default: Name · Account · Stage · Amount · Owner · Created · Close Date · Age in
stage. Project-side views swap in Project #, PM, Contract Value, % Billed.

### 5.4 Mobile

A Salesforce list view is unusable on a phone and **Alex reads this on his phone every
morning**. Below `sm`, the table becomes the card fallback we already use in
`leaderboard.tsx`. Non-negotiable.

---

## 6. Status

### 6.1 Sales ladder (opportunity)

New opps land **assigned** and move on their own, driven by artifacts — the engine
built 2026-08-11. Path bar renders the ladder from `SUB_STATUSES_BY_STATUS`; no
second list (that divergence is finding R14/H1).

### 6.2 Delivery ladder (project)

Pre-construction → In progress → Substantially complete → Billing → Closed out.

**Two separate path bars, not one long one.** A single 11-stop path is unreadable, and
the two ladders have different owners.

---

## 7. Stage-aware KPIs

Only what's live for the current stage. Elapsed time is a first-class number
(Karan: *"if we sent a proposal — how long ago?"*).

| Stage | Shows |
|---|---|
| Bidding | RFP received · proposal due in N days · days since plans arrived |
| Proposal sent | amount · **sent N days ago** · viewed? · follow-up due |
| Won, not started | contract value · margin · days since won · what blocks the start |
| In progress | % billed · billed vs contract · approved COs · open submittals · crew hours |
| Billing | retainage held · AR outstanding · oldest unpaid invoice |
| Closed | final margin · warranty expiry |

A won job never shows "proposal due." A bid never shows retainage.

---

## 8. Edge cases

The part that decides whether this lands clean.

### Project creation

1. **Won → project created.** Creation hangs off the *status writer*
   (`changeOpportunityStatus`), not the UI — otherwise the auto-advance engine, the
   board, the debrief and the repair screen each need their own copy.
2. **Idempotency.** Status can bounce won → lost → won. `UNIQUE(opportunity_id)` plus
   an upsert; never a second project.
3. **Deals that skip the win.** `WARN_TRANSITIONS` exists precisely because a deal can
   be dragged from `proposal` straight into `in_progress`. Project creation must fire
   on **entering any delivery status**, not on the `won` transition alone. Missing this
   reproduces the "won, working, invisible" bug from the decided_at cluster.
4. **Un-winning a deal that has a project.** Do **not** delete the project — it may
   hold invoices. Mark it `archived_at` and warn. (`feedback_never_reject_only_warn`.)
5. **Backfill.** One project per won/delivering/closed opp, including legacy rows whose
   `decided_at` is null.
6. **Project number — do NOT re-issue.** `project_number` is assigned today at
   *opportunity insert* (migration 046), so **lost bids already hold numbers** and
   documents already cite them. The project **inherits** the opp's number. Re-issuing
   breaks every PDF, email and AIA cover sheet in the field.
7. **Deleted / archived opps** get a project too, inheriting the archived flag —
   otherwise they vanish from history.
8. **Orphans.** Pre-flight count of delivery rows whose `opportunity_id` points at a
   missing opp *before* backfill. We shipped orphan-leak fixes in Field Ops; assume
   some exist.

### Money

9. **`contract_base_cents` is set once at award and never recomputed.** Reuse
   `pickContractBaseCents`'s rung order (manual → accepted → snapshot → …) and record
   which rung won in `contract_source`. This is the F1 fix; the split must not reopen it.
10. **No fake zeros.** No accepted proposal and no manual figure → `null`, and the page
    reads *"contract value not set."* Never `$0.00` — that reads as a real number and
    poisons every rollup.
11. **Current contract value = base + approved COs, computed, never stored.** Storing it
    is how the AIA rewrite bug (F2) happened.
12. **Two amounts, two reports.** Win-rate groups by *opportunity* owner and quoted
    subtotal; job-cost/margin groups by *project* owner and contract value. Every
    existing report groups by opp owner today — **all six need auditing**, they are the
    most likely place a silently-wrong number survives this.
13. **Notification routing splits with ownership.** Sales alerts → opp owner; delivery
    alerts → project owner. Today every rule targets the opp owner.

### Migration

14. `commercial_jobs.project_id` **nullable** — field-ops one-offs have no project and
    no opp.
15. **RLS policies referencing `opportunity_id`** must be updated in the same migration
    or they silently over- or under-deny.
16. **Deploy gate.** Code that writes a new column deploys before the migration runs and
    every write fails. Use the retry-without-new-columns pattern from R25/R31.
17. Backfill must be **idempotent and re-runnable** — `on conflict do nothing`, and
    guarded so a half-applied run is safe to repeat.

### Navigation

18. **`?back=` whitelist.** `resolveToolBack` anchors a regex on the account drill-in
    URL shape. Add the new opportunity shape **in the same commit** — this exact bug
    already shipped once, silently dropping every back link.
19. **Save-action redirects.** Each tool page has a dozen-plus server actions that
    redirect to their *own* address. Missing these makes the move *look* done: you click
    in, stay in, save, and get ejected. This was the real work in the R-series and it
    will be again.
20. **Stored notification URLs** point at old routes. The 308s cover them — verify.
21. **Public token routes** (proposal / invoice / submittal links already in GCs'
    inboxes) are unaffected, but confirm — a dead link to a customer is the worst
    possible failure here.
22. **Command palette, keyboard shortcuts, onboarding walkthrough** all hardcode routes.
23. **Deep links carrying `&dt=` + `#anchor`** must land on the equivalent tab + anchor.

### List view

24. Filter + sort + column choice + scroll position survive navigating away and back
    (`feedback_page_flow_navigation`).
25. A saved view referencing a **deleted user or a retired status** must degrade to a
    readable warning, not a 500.
26. Header totals must sum **the same field the column displays**, or the header lies.
27. Any picker past 10–15 entries is a **searchable combobox**
    (`feedback_searchable_dropdowns`).

### KPIs

28. *"Proposal sent 9 days ago"* = the latest **sent** proposal, not the latest created.
    A drafted revision must not reset the clock.
29. Elapsed days via `etDateOf` (Eastern), never raw UTC subtraction — DST silently
    shifts day counts.
30. No proposal → **hide** the tile. Never "sent 0 days ago".
31. Won deal whose project row hasn't been created yet (race / mid-backfill) must render,
    not crash.
32. **Path bar for a lost deal** shows a collapsed terminal state, not six hopeful future
    stages.
33. **Skipped stages render as skipped**, not complete — a dragged-forward deal never
    passed through them.

---

## 9. Build order

Each step ships green and leaves the app working.

| # | Step | Risk |
|---|---|---|
| 1 | Migration: `commercial_projects` + `project_id` on 8 tables + drift triggers + backfill | **High** — the money step |
| 2 | Project creation wired into the status writer (§8.1–8.5) + tests | High |
| 3 | Opportunity page absorbs the 7 tools; old routes 308; `?back=` + save-redirects (§8.18–8.19) | Medium |
| 4 | Status path bars (sales + delivery) | Low |
| 5 | Stage-aware KPIs | Low |
| 6 | Account page trimmed to the shelf | Low |
| 7 | List view: saved views, totals, filter chips, grouping, mobile cards | Medium |
| 8 | Sidebar collapsed; AR to Reports; kanban retired | Low |
| 9 | Report audit against the two-owner / two-amount split (§8.12) | **High** — quietly wrong numbers |
| 10 | Dashboard pass | Low |

Steps 1–2 are one unit: **never ship the table without the writer.** An empty
`commercial_projects` with live `project_id` columns is worse than no table.

---

## 10. Assumptions

Proceeding on these; correct before step 1 if wrong.

1. **One opportunity → one project.** UI built 1:1; the FK shape supports 1:N later
   without another migration. Multi-building jobs stay one project with phases, matching
   the scheduling model already shipped.
2. **`opportunity_id` nullable** on a project — direct T&M work needs no fake bid.
3. **Proposals stay on the opportunity.** The line the migration is drawn along; Karan
   confirmed 2026-08-12.
4. **`project_number` inherited, never re-issued** (§8.6).

---

## 11. Cross-session handoff

Session B: read this before touching `commercial_opportunities`, any delivery table, or
`app/commercial/accounts/[id]/page.tsx`.

- **The audit backlog is closed** — 98 items across the five lists, all fixed or declined
  in writing. No R46+. This restructure is the next work.
- **Do not start step 1** without confirming here first; it rewrites FKs on 8 tables and
  a concurrent migration number collides.
- **Safe to work in parallel:** Stephanie's list (proposal page order, Submittals
  feedback, Letter of Transmittal + tap-to-sign — LoT is the one document still missing
  it), Reports (pending Katie's list), RFP email auto-populate, Foreman Daily Log.
- **Migration numbers:** 126–130 applied. This restructure claims **131+**. Take 140+ for
  anything unrelated to avoid a collision.
- If you touch `resolveToolBack`, `changeOpportunityStatus`, or `pickContractBaseCents`,
  say so here — all three are load-bearing for this plan.
