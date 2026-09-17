# Projected calendar — the plan

Karan, 2026-09-17, deferred but asked for a plan:

> Smart projected calendar that is like a reminder — if a due date for a project
> is like 6 months ago, or like it might not happen, still in the talks, it'll
> give us a little nudge like *is this still happening?* We have a lot of work
> this month, do we have enough crew? Make a projected tab under Field Ops.
> Attached vs projection **toggle** instead of two tabs. We can click off what we
> do and don't want to see, like pinning upcoming jobs. Different color-coded —
> when you bid it's green.

---

## Start here: there is nothing to project yet

Measured against the live book, 2026-09-17:

| Stage | Deals | With an expected start |
|---|---|---|
| Proposal · sent | 29 | **0** |
| Estimating | 9 | **0** |
| Pre-construction · coordination | 8 | **0** |
| In progress · on site | 16 | 5 |
| Billing · completed and invoiced | 11 | 11 |
| Post-sale closed | 56 | 56 |

**Every deal that has a date is one where the work is already underway or
finished.** All 74 came from the Salesforce import, which read the work order's
`StartDate` — a date that only exists once a job is scheduled. Every OPEN deal —
the 46 this feature is entirely about — has none.

So a projected calendar built today renders an empty month, and would keep
rendering an empty month no matter how good it was. **The feature is a data
capture problem first and a calendar second.** Anything else is building a
window onto nothing.

That is why `proposed_start_at` / `proposed_end_at` were made editable on the
job page today (`b9a38e18`) — that is step 0, already done, and it reverses a
call of Brendan's that should be confirmed with him.

---

## The four pieces, in the order they pay off

### 1. Capture — make the date unavoidable, not optional

A field nobody fills is the same as no field. Two places it has to be asked for:

- **The attention rail.** `attentionFor()` in
  `lib/commercial/opportunities/attention.ts` already returns
  `{key, title, consequence, href, tone}` and already drives the "needs
  attention" banners. A new rule — *"No expected start · nothing to plan crew
  around"* on any deal at Sent or Pre-construction — puts the ask in the place
  people already look, with a link straight to the field.
- **The won transition.** Moving a deal to Pre-construction without an expected
  start is the moment it matters, because that job is about to need crew.

**Do NOT invent a second nudge system.** `attentionFor` is the rule engine, it
is pure, and it is already tested. Every "is this still happening?" prompt below
is a rule in it.

### 2. The nudges — all of them are attention rules

Karan named three; each is a predicate over data that already exists:

| Nudge | Predicate | Data |
|---|---|---|
| "Is this still happening?" | Expected start is in the PAST and the deal is still open | `proposed_start_at < today` + pre-sale status |
| "This has gone quiet" | Sent, and no activity for N days | `updated_at`, and `STALE_OPP_DAYS` already exists |
| "Do we have enough crew?" | Projected hours in a month exceed crew capacity | below |

**Capacity is the only new arithmetic**, and it must not be invented loosely:

- Supply = active crew × working days in the period × a day length. There are
  **23 active crew** and the standard day is 7:00–15:00 (8h), now the scheduling
  default — so one crew-day is 8h and the constant already exists.
- Demand = scheduled hours (real, from `commercial_assignments`) **plus**
  projected hours from open deals.
- Projected hours per deal is the honest problem: we do not have an hours
  estimate on an opportunity. Options, cheapest first: (a) spread the deal's
  labor budget over its expected window; (b) ask for a crew-size guess on the
  deal; (c) derive from similar past jobs. **(a) is the only one needing no new
  input** — and it is a guess, so the UI must say so.

### 3. The calendar — one surface, a toggle, not two tabs

Karan was explicit: a **toggle**, not two tabs.

The data shape is already solved. `getMonthOverview` and `getWeekOverview`
(`lib/commercial/field-ops/schedule.ts`) both return `MonthDay[]`, and today's
week view proved a second period reuses the same cell with no downstream change.
A projection is a **third producer of the same shape**: same `MonthDay[]`, with
crew entries marked projected rather than real.

That is the whole architectural decision — projected days are not a parallel
model, they are the same day carrying uncertain rows. It keeps the existing cell,
the existing day panel, and the existing week/month switcher.

**The toggle is three states, not two:** Attached only · Projection only · Both.
"Both" is the one that answers "do we have enough crew", because it is the only
view where committed and expected work are added up together — and that sum is
the only number in the feature that must never be presented as fact.

### 4. Filtering, pinning, color

- **Color by stage.** `columnKeyForOpp(status, sub_status)` already maps a deal
  to one of ten stages, and `kanbanColumnLabel` names them. Color belongs
  **next to that map**, not in the calendar — a stage color defined in the
  calendar is one the pipeline cannot use. Note Karan's "when you bid it's
  green" conflicts with the existing delivery language (green = done, amber = in
  progress, grey = not started), which is written down as a rule. **Pick one and
  change the other**; two color languages on one platform is worse than either.
- **Click off what you don't want.** A searchParam per toggled group, defaulting
  to all on. Same shape as the AR sheet's group-by row.
- **Pinning.** Needs storage. `commercial_settings` already holds per-key JSON
  (the AR carryover edits use it) — a `pinned_opportunity_ids` key avoids a
  migration, and this is a preference, not a record.

---

## What I would NOT do

- **No new table.** Every input exists or belongs on the opportunity.
- **No writing projected shifts into `commercial_assignments`.** A projection
  that lands in the same table as real scheduling is a projection somebody will
  eventually email to a crew. They must stay derived.
- **No auto-scheduling.** "Do we have enough crew" is a question to a person.

## Risks

1. **The empty-calendar trap.** If capture (1) is skipped, this ships and shows
   nothing — and the previous version of that mistake is the Labor report, which
   was structurally blank for months while looking fine.
2. **A guess rendered like a fact.** Projected crew hours are inferred. They must
   be visually distinct and labelled, and must never be summed into a figure
   anyone reports.
3. **Two color languages** — see above. A decision, not an implementation
   detail.
4. **The Sunday/Monday split.** The calendar's weeks are Sunday-start; payroll
   and `copyWeekForward` are Monday-start. That mismatch already produced a real
   bug today (copy week took the wrong seven days). Any capacity-per-week maths
   must state which week it means.

## Order

0. ~~Make the expected dates editable~~ — done, `b9a38e18`.
1. Attention rule: no expected start on an open/pre-construction deal.
2. Attention rule: expected start in the past, deal still open ("is this still
   happening?").
3. `getProjectionOverview()` returning `MonthDay[]` from open deals.
4. The three-state toggle on the existing calendar.
5. Capacity line: supply vs. committed vs. projected, with the guess labelled.
6. Stage color (after the color-language decision), filters, pinning.

Steps 1–2 are useful **on their own**, with no calendar at all: they are what
starts filling the column the rest of it reads.
