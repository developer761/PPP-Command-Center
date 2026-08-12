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
