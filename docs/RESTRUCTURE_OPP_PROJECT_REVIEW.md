# Pre-audit review — Opp/Project restructure plan (verification session, 2026-08-12)

Reviewed `RESTRUCTURE_OPP_PROJECT_2026_08.md`. **Verdict: strong plan, approve the
direction.** The data-split rationale is right, the migration approach (add
`project_id`, keep `opportunity_id`, trigger-enforce the mirror) is the safe one,
project-creation-on-the-status-writer is correct, and it already guards F1/F2/R25/
F12 and flags the report audit as the top risk. The 33 edge cases are real.

Below are gaps/risks it **under-specifies** — resolve these before step 1. Ranked.

## 🔴 A. The STATUS-MODEL split is the biggest under-addressed ripple
Today `opportunity.status` is ONE field spanning BOTH ladders — `qualifying …
proposal · pre_sale_closed · pre_construction · in_progress · billing ·
post_sale_closed`. Half the platform reads post-sale values **off the opportunity**:
`dealPhase`, `isPostSaleProject`, `stageRank`, `wasWonInPeriod`, `IN_DELIVERY_STATUSES`,
the **auto-advance engine + its atomic `stageRank` guard**, `kanban-columns`, the
Overview 3-way phase swap, the "needs debrief" gate, `getProjectFinancials`'s callers.
§6 says the delivery ladder moves to `commercial_projects.status` and there are "two
path bars" — but the plan **does not say what happens to the opp's post-sale statuses
or how those ~10 predicates/engines adapt**. Two viable models, pick one explicitly:
- **(i) Opp keeps its full status (pre+post), project.status mirrors the delivery half** — least ripple, but now two status fields can drift (needs a trigger too).
- **(ii) Opp status becomes sales-only (caps at won/lost), project.status owns delivery** — cleaner, but `dealPhase`/`isPostSaleProject`/`wasWonInPeriod`/the auto-advance stageRank/the Overview swap ALL must be reworked to read `project.status` for the post-sale half, and the auto-advance engine (which caps at `won` and never enters delivery — R-audit A2/§4b) needs its "won → project exists" handoff redefined.
**This is a step-0 decision, not a step-4 path-bar detail.** Whichever model, name every predicate/engine that changes, or the phase-aware Overview + win reporting silently break.

## 🔴 B. `project.contract_base_cents` vs the existing `accepted_contract_cents` (migration 127) — source-of-truth / drift
The F1 fix (this month) already added `commercial_opportunities.accepted_contract_cents`
as the remembered signed contract, written on win via `writeAcceptedContract`, and
`pickContractBaseCents` prefers it. The plan adds `commercial_projects.contract_base_cents`
from the **same** `pickContractBaseCents` rung order. So the signed contract now lives
in **two columns**. State explicitly: project.contract_base_cents is the source of
truth post-award, opp.accepted_contract_cents is retired-or-mirrored, and **every
contract reader (`getProjectFinancials`, AIA `pickContractBaseCents`, the ladder)
switches to the project column** — otherwise this reopens F1 as a two-column drift.

## 🔴 C. "Set once at award, never recomputed" is WRONG for a legitimate re-win
§8.9/§10.4 say `contract_base_cents` is set once and never recomputed. But the F1 fix
deliberately **updates** the remembered contract when a NEW revision is won (R1 won
$450k → R2 won $500k → contract becomes $500k; `accepted-contract.ts` re-writes the
snapshot on each win). "Never recomputed" would freeze the contract at R1 and silently
under/over-state a re-won job — the inverse F1 bug. Correct rule: **set on entry to
delivery, and re-write whenever a newer revision is won** (reuse `writeAcceptedContract`'s
"skip if unchanged, else update" logic), NOT frozen forever.

## 🟠 D. Soft-delete cascade must handle the project row
The plan's `on delete restrict` (§3.1) only guards a HARD delete — but the app
soft-deletes opps (`deleted_at`) and cascades to jobs/invoices/purchases (the cascade
we audited). §8.4 covers *un-winning* (archive the project) but not **soft-deleting an
opp that owns a project**: the cascade must also archive/soft-delete the project (and
its `project_id`-linked children), and the undo-restore must bring it back. Add to §8
and to `cascadeDeleteJobsForOwner`/the opp delete path.

## 🟠 E. The F12 in-drill-in work gets re-homed — high R32-class risk
We just shipped submittal/invoice/proposal opening INSIDE the deal via
`?tab=projects&project=<d>&dt=…&sid=/&inv=`, with `DRILL_IN_RE`-guarded `?back=` and
~13+ save-redirects per tool. Moving to `/opportunities/<d>?tab=…` means re-pointing
`DRILL_IN_RE`, the `&sid=/&inv=` inline renders, AND every save-redirect (§8.18-19
flags this — good). Emphasis: this is exactly the R32 class ("success redirect strips
the origin"). Do the `resolveToolBack` regex + ALL save-redirects **in the same commit**
as each route move, and I'll re-audit each tool's redirects specifically.

## 🟡 F. Smaller confirms
- **`decided_at` stays on the OPPORTUNITY** (the win moment / win-rate basis, grouped by opp owner); `started_at`/`closed_out_at` on the project. The plan moves `closed_out_at` to the project — confirm `decided_at` and the `closed_out_at` **wasWonInPeriod legacy guard** (R33) move coherently, and that win-rate still reads opp-side.
- **Backfill ordering + the drift trigger:** create ALL projects first, THEN backfill `project_id`, so the insert/update trigger (§3.3) can't reject mid-backfill. State the order.
- **Cross-phase list "Amount" (§5.3/§8.26):** an *All Open* list mixing bidding opps + delivering projects — the header total sums "Amount," but that's quoted-subtotal for one and contract-value for the other. Decide whether the mixed total is meaningful or the column/total is phase-scoped.
- **Notification `source`** (auto/reconcile/user) threaded through `changeOpportunityStatus` (R33) — project-creation-on-the-writer must pass it so a backfill/auto move doesn't spam the team.

## Offer
Steps 1–2 (the migration + status-writer) and step 9 (report audit) are the two
**High** rows — I'll do a dedicated pre-audit of the migration SQL (drift trigger,
backfill idempotency, RLS, deploy-gate) and an after-audit of the report two-owner/
two-amount split, plus re-audit each tool's save-redirects as the routes move. Ping
me here (a `docs/` commit) when step 1's SQL is drafted and I'll review it before it runs.

---

## Follow-up on a27cb9b (record anatomy · send surface · edge 34–41)
These additions are **sound** — the path-bar spec, the send-document surface, and
edge cases 34–41 are well-reasoned (39 correctly names the React-19 form-reset
class; 35 keeps the manual-advance CTA from fighting the auto-advance engine; 40/41
make the Activity rail a read of existing data, not a new table). Approve.

**One new gap — inline ✏ field edit (§4.5.5, edges 38/39) needs BUSINESS-LOGIC
parity, not just permission + autosave parity.** Edge 38 covers permissions and 39
covers autosave, but a pencil-edit of a **money/business field** must run the same
*side-effects* the `/edit` route does, or it silently diverges:
- Original contract → must set `original_contract_is_manual` (F6) and re-rank
  `pickContractBaseCents`; else an inline edit is accepted-then-ignored.
- Tax fields → must re-resolve ZIP jurisdiction + honor `account.tax_exempt` (C3).
- Status/owner/amount that the split now routes to opp-vs-project → the pencil must
  write the correct record.
Add an edge: "inline edit routes through the SAME action/validation/side-effects as
the full edit form; the pencil is a UI affordance over that action, never a second
write path." (This is the completeness/'two write paths' class from C7–C10.)

**Still open from my main review (A–F above):** the status-model split (A), the
`contract_base_cents` vs `accepted_contract_cents` source-of-truth (B), and "never
recompute" vs a legitimate re-win (C) are step-0 blockers not yet addressed in the
plan. Please fold A/B/C in before step 1's migration.

---

## AUDIT — Steps 1-2 shipped (`8885bab` + post-flight `4fd9daa`)

Read migration 131, `lib/commercial/projects/ensure.ts`, the `changeOpportunityStatus`
hook, and traced every opp-mutation path. **Verdict: strong. Ship it.** The design
answers my A/C/D at the writer, and the risky parts are handled well:
- **Drift guard** — the BEFORE trigger is correct: fires only when both ids are present
  and disagree, fills a blank `opportunity_id`, no-ops on a NULL project (T&M). Minimal
  `UPDATE OF project_id, opportunity_id` scope. ✓
- **Backfill** — the "won OR carrying delivery artifacts" rule is right (9 real deals,
  not 1); `ON CONFLICT DO NOTHING` + `project_id IS NULL` guards make it idempotent;
  soft-deleted/archived flags inherited. Post-flight confirms 11 projects / 63-of-63
  linked / guard attacked. ✓
- **Gap C (re-win)** — RESOLVED for now: `ensureProjectForOpportunity` fills a blank
  `contract_base_cents` but never overwrites; re-deciding stays `snapshotAcceptedContract`'s
  job. `owner_user_id` likewise never re-stamped (PM reassignment survives). ✓
- **contract_source** dropped bid-midpoint from the award ladder entirely (accepted →
  won-proposal → latest-proposal → NULL), so a bid-only deal renders "not set", never a
  fake signed number. Cleaner than the plan's enum. ✓
- No hard-delete of opps anywhere → `ON DELETE RESTRICT` never fires from the app. ✓

### 🔴 1. Soft-delete / archive cascade does NOT reach the project row — the ONE must-fix
`ensureProjectForOpportunity` mirrors `deleted_at` and `archived_at` from the opp — but
only `changeOpportunityStatus` calls it. The **delete and archive paths bypass it**:
- `softDeleteCommercialOpportunity` (mutations.ts) cascades to invoices, purchases and
  field-ops jobs — but **not** `commercial_projects`. The project (with its
  `contract_base_cents`) stays `deleted_at = NULL` = live.
- `archiveOpportunity` / `unarchiveOpportunity` (db.ts) set `archived_at` directly and
  never touch the project.
- `restoreCommercialOpportunity` restores the cascaded children but not the project.

Masked **today** only because no surface reads `commercial_projects` yet — but a
project/opportunity list is the entire point of this restructure, and the moment it
ships this is a **zombie project feeding a rollup nobody can trace to a deleted deal** —
the *exact* class `softDeleteCommercialOpportunity`'s own purchases-cascade comment calls
"the worst kind." Per Karan's no-defer rule, fix it **now**, in the same family as this
commit, not at the list step. Cheap: `ensureProjectForOpportunity` already does the
mirroring — just call it best-effort (in a `try`) at the tail of `softDelete`,
`restore`, `archive`, and `unarchive` (a won+deleted opp keeps `shouldExist=true`, so
the reconcile patch sets `deleted_at`/`archived_at`/back-to-null correctly). Add a test:
soft-delete a won deal → its project is `deleted_at`-stamped; restore → cleared.

### 🟠 2. Forward flag for the READER-SWITCH step (gap B/C) — do NOT let a re-win go stale
The fill-blank-only rule is right *because readers still use `accepted_contract_cents`*.
When a later step points `getProjectFinancials` / AIA `pickContractBaseCents` at
`project.contract_base_cents`, the re-win case reopens F1: R1 won $450k → un-won → R2 won
$500k leaves `project.contract_base_cents` frozen at $450k (fill-blank skips a non-null),
while `accepted_contract_cents` correctly reads $500k. So the reader-switch step must
EITHER keep reading `accepted_contract_cents` for the live figure, OR make `ensureProject`
re-write `contract_base_cents` on a newer win. Decide it *at that step* — don't switch
readers blindly.

### 🟠 3. Forward flag for the DELIVERY PATH-BAR step (gap A) — one-way status mirror
This is model (i): `opp.status` keeps its full range, `project.status` mirrors the
delivery half **one-way** via `ensureProject`. Consistent today (delivery is still driven
off `opp.status`, and every predicate — `dealPhase`/`isPostSaleProject`/`stageRank`/the
Overview swap — still reads the opp). When the delivery path bar ships it MUST write
through `changeOpportunityStatus` (`opp.status`) so `ensureProject` re-derives
`project.status`; a direct write to `project.status` would silently drift the two. State
this on the path-bar step, and name which predicates (if any) move to read `project.status`.
