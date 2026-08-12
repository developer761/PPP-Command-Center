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

---

## EDGE SWEEP — 13 NEW verified cases for the LATER steps (4/5/9), grounded in code

A 31-agent adversarial sweep (verified against the live code) surfaced these — none are
in the plan's 41 or A–F above, and they are **prerequisites for the steps not yet built**
(delivery path bar, list view, reports, send surface). They cluster into 5 themes. Nothing
here blocks steps 1-2 (already shipped and sound); each blocks the step named.

**⚠️ Correction to my Review A:** I wrote "the auto-advance engine caps at won." That is
**wrong.** `auto-advance-targets.ts` has a `closed` target (`post_sale_closed·closed`,
`exactFrom post_sale_closed·closeout`) that `closeout/db.ts:220` fires — a genuine
**delivery-side** auto-advance. That changes theme 1 below.

### 🔴 Theme 1 — the DELIVERY ladder has no infrastructure (blocks steps 4/5)
Everything delivery-side today borrows the SALES machinery, and the split takes it away:
- **No `changeProjectStatus` writer.** `lib/commercial/projects/` has ensure/db/financials/
  accepted-contract only. Every transition goes through `changeOpportunityStatus` (opp-only:
  opp status log, opp-owner notify, `status_user_set_at`, `_requireFrom` guard). A step-4
  delivery CTA ("Mark In Progress") has **nothing to call** — build it ad-hoc and delivery
  moves get no audit row, no project-owner notification (so §8.13 can't fire), no forward-only
  guard. **Build `changeProjectStatus` as a prerequisite of step 4**, mirroring the opp writer.
- **No `commercial_project_status_log`.** Consequence cascade, all verified:
  - **Age-in-stage freezes at the win date** for every delivery row — `listCurrentStatusEnteredAtByOpp`
    reads the opp log, whose last row (model ii) is the WIN. A job 3 weeks into Billing shows
    "won 200 days ago." Uncomputable from the planned `commercial_projects` schema (only
    `started_at`/`substantially_complete_at`/`closed_out_at`).
  - **Edge 33 (skipped vs passed stage) unsatisfiable** on the delivery bar — `deal-journey-strip`
    colors by ordinal; with no per-transition history it can't tell a skipped stage from a passed one.
  - **Activity rail + Account 360 go blind to delivery moves** — `getAccountRecentActivity` unions
    only opp-keyed sources; every `pre_construction→…→billing` move produces zero rail entries,
    exactly when the job is most active (contradicts edge 40 / §7).
  - **Fix:** create `commercial_project_status_log` (project_id, from/to, changed_at, changed_by,
    source), written by `changeProjectStatus`; read it for age-in-stage (per-phase source switch:
    sales rows → opp log, delivery rows → project log), the delivery bar, and the rail.
- **`closeout→closed` auto-advance writes the OPP** (the correction above). Post-split it must
  re-point to `changeProjectStatus` (target `project.status='closed'`), or closeout stops closing
  jobs / stamps an orphaned `post_sale_closed` on a sales-only opp.
- **Backfill must relocate existing delivery history** (step 1 addendum): the 9 backfilled deals
  already have delivery-status rows in the opp log (e.g. `→pre_construction`). Copy every opp-log
  row whose `to_status` is a delivery value into the new project log, and mark/drop them so the
  sales bar + rail stop rendering them as opp events (edge-25 retired-status class).

### 🔴 Theme 2 — null-opp T&M projects break every rollup (blocks reports/list, step 9)
The plan makes `opportunity_id` nullable for T&M — but the entire financial layer is opp-keyed:
- **Silent omission:** `listProjects` selects `from('commercial_opportunities')`, so a null-opp
  project never appears — its billed revenue + costs vanish from Job Costs, account Profitability,
  dashboard P&L, the deal Costs tab. `getProjectFinancials(oppId)` reads everything via
  `.eq('opportunity_id', …)` — uncomputable with no oppId. §8.10's "existing queries keep working"
  is false for this class; §8.12's audit covers mis-grouping, not missing rows.
- **Crash counterpart:** once `listProjects` is re-keyed to iterate `commercial_projects` (the
  natural end-state), `job-costs.ts:135-136` calls `derivedOppName(p.opp)` / `p.opp.status` with
  no null guard → 500 on Job Costs / Profitability. ~a dozen `.opp.` derefs must be audited.
- **Fix:** re-key the financial layer to `project_id` (mirror trigger keeps opp-keyed rows working);
  make `ProjectRow.opp` nullable with a project-name/PM/`project.status` fallback everywhere;
  until then, block T&M-project creation. Fold null-opp into the step-9 audit explicitly.

### 🔴 Theme 3 — the drill-in redirect is NOT a next.config rule (blocks the route move, step 3)
The dominant old link — `/commercial/accounts/<a>?tab=projects&project=<d>&dt=<tool>` (page.tsx
316/804/881, archived list, invoices/[id] 788/851, project-card, tool-back-header) — is a **query
drill-in on the surviving lean account page**, not a distinct path. A path/`tab=projects`-keyed
redirect either hijacks the account's own list tab or misses `<d>` (it's in the query). And `dt`
values don't match new `tab` names (`costs→transactions`, `pnl→?`, `project→alias`, unknown→
silently coerced to overview — a soft dead-end that *looks* like it worked). **Fix:** redirect
*inside* the `/commercial/accounts/[id]` server component when `tab==='projects' && valid project=<uuid>`,
with an explicit `dt→tab` map, preserving `#anchor`/`sid=`/`inv=`. Leave bare `?tab=projects`
rendering the account's list. Also: **every new `/api/commercial/projects/**` route must call
`denyCrewApi(user.id)`** — the crew allowlist gates pages only (proven by the opportunities
sign-route's own `denyCrewApi`); the upload client already targets `/api/commercial/projects/<id>/documents`,
a route that doesn't exist yet — born crew-denied, not retrofitted.

### 🔴 Theme 4 — multi-CC/BCC on the send surface (blocks §4.6, step 4/5)
Verified in `proposals/email.ts`: (1) **multi-CC is rejected** — CC is validated with a
single-address regex (`EMAIL_RE`, line 67), so `"pm@gc.com, super@gc.com"` fails; even if it
passed, the raw joined string is handed to Resend's `cc` as one address. (2) **Brendan BCC
leak/dup** — the silent-BCC dedup `PROPOSAL_COPY_EMAILS.filter(e => e !== ccEmail)` compares each
copy address to the *entire joined* CC string, so with a multi-valued CC Brendan is never filtered:
he lands in both the visible CC (internal list leaked to the GC) **and** the hidden BCC (double
delivery). (3) A user **BCC isn't pre-validated** and `sendProposal` marks the proposal `sent`
*before* the Resend call — a fat-fingered BCC errors after "sent" or is silently dropped. **Fix:**
parse CC/BCC on comma → trim → lowercase → `EMAIL_RE` each, reject the specific bad address
*before* marking sent; pass validated **arrays** to Resend; compute BCC against a lowercase Set of
To+CC so nothing appears twice and the internal list never leaks. (Preserves the Brendan
approve→send / reply-to-GC routing — just makes it multi-value-safe.)

### 🟠 Theme 5 — list group-by-owner is ambiguous across phases (blocks list view, step 5)
The split gives the sale an owner (`estimator_user_id`) and the work a different owner
(`project.owner_user_id`). A single "Owner" column + group-by-owner on a cross-phase list files
every PM-run delivery row under the estimator (or vice-versa); a per-group `$` subtotal adds
pipeline/quoted-subtotal to contract-value within one group — the per-group twin of the mixed
header-total (my F). §8.12 flags this for *reports* (each phase-homogeneous) but not the *list*.
**Fix:** resolve the ladder-appropriate owner per row (or two owner facets); any group/header `$`
subtotal must be phase-scoped (sum same-amount-type only, or show pipeline-$ vs contract-$ twins).

---

## SIDE AUDIT — `scripts/wipe-commercial-data.sql` (`dd8e580`, not applied / never auto-run)

Audited the pre-go-live wipe. **FK-safe and will run to completion** — I specifically
hunted for a kept table with a `RESTRICT`/`NO ACTION` FK to a deleted parent (which would
abort the all-or-nothing transaction) and there is none: the only kept→deleted FK is
`commercial_customer_prices.account_id → commercial_accounts ON DELETE CASCADE`. Ordering
verified — all 8 `project_id` children delete before `commercial_projects` (line 74), which
deletes before `commercial_opportunities` (line 84). The 10 untouched tables == the kept
config set. Two notes:

- **🟠 Header/behavior mismatch on customer prices.** The header lists "customer prices"
  under *KEPT — configuration, not job data*, but `customer_prices.account_id` is `NOT NULL`
  with `ON DELETE CASCADE`, so deleting the accounts (line 94) **cascade-deletes every
  customer-price row** — the table ends up empty, contradicting "kept." Harmless at go-live
  (no real accounts yet), but the doc is wrong: account-scoped prices are job data and go
  with the accounts. Either drop them from the "kept" line, or (if a reusable price book was
  intended) that's a schema question, not a script one.
- **🟠 "Reported success but removed nothing" must be resolved before the real run.** If it
  silently no-ops again at go-live, Tomco starts on test data. The run should confirm the
  end-of-script counts are actually 0 (run in a transaction, check counts, then COMMIT) —
  not trust "success."

---

## AUDIT — Step 3 shipped (`f7906b1`, route move / opportunity is the job's home)

**Verdict: strong, and the R32-class risks I flagged (theme 3 / gap E) are handled well.**
The bounce/allowlist is deleted (not disabled), old URLs 308-redirect in ONE hop, the
submittal backward-redirect is collapsed, and — the part I was most worried about — the
back-guards were taught the new shape correctly: `tool-back-header.tsx` keeps
`DEAL_DRILL_IN_BACK_RE` **and** adds `OPPORTUNITY_BACK_RE` (both shapes, anchors included),
with the R-series lesson documented inline. The `dt→tab` redirect map (account page
470-493) handles every value (`costs→transactions`, `pnl/overview→overview`,
`documents→docs·files`, `proposals`/`invoices`). The costs-tool stale-revalidate bug the
sweep found is a real catch. Good work.

### 🟠 One 90%-done gap: the account page's OWN live deal links were NOT rewritten
The commit says it "swept every reference **rather than relying on the redirects**" — but
the surviving lean account page still emits the **old redirecting shape**
(`?tab=projects&project=<d>…`) on its own live surfaces, so they lean on exactly the
redirect the commit claims to have avoided. Confirmed-live (not the dead `AccountProjectHome`
being removed next):
- `PipelineDealBlock` line ~1019 — the pipeline/lost deal cards on Account Home (rendered
  at 958/990). The **primary account→deal click** takes a redirect hop.
- `DocumentRow` line ~5494 — `&dt=invoices#deal-invoices`.
- Post-save server-action `redirect()`s at ~2161 (`editDealFromAccountAction`) and ~2341
  (`recordPaymentInlineAction`, `&deal_created=1`) — a **save now double-redirects**
  (old-shape → account redirect → opportunity). Works, but it's the save-redirect class.
- Plus the deal-list row hrefs (~3994, 6397, 6811).

**Two concrete harms, not just tidiness:** (1) every one of these is an extra redirect hop
on the account's most-trafficked path; (2) the hash-bearing ones (`#deal-invoices`,
`#deal-proposals`) **lose their anchor** — the account redirect rebuilds the URL from query
params only, and a `#fragment` never reaches the server (verified at line 493), so the link
lands on the right tab but not scrolled to the section. **Fix:** rewrite these to
`/commercial/opportunities/<dealId>?tab=…&sub=…` directly (same map as the redirect; the
tab moots the old anchor), so account→deal is one hop and the sweep's own claim holds. The
`AccountProjectHome` removal (next commit) won't touch these — they're in the lean page.

### Step-3 cleanup (`fbb061b`) — verified clean
Pure deletion of the now-unreachable `AccountProjectHome` + 3 panels (1,251 lines).
**Confirmed no orphans:** zero live references to any deleted symbol; tsc/tests/build green.
The ~45 deferred unused imports are an **acceptable** deferral (inert / tree-shaken / risky
to auto-sweep on a 7.5k-line file / explicitly tracked) — not the never-defer class, since
nothing is left broken. **NOTE: the step-3 live-links gap above is still OPEN** — the cleanup
didn't address it; the old-shape account→deal links survive (now at 1011, 1562, redirects
1887/2067, DocumentRow 5220 `#deal-invoices`, rows 4505/5052/6123). Fold that in with the
unused-import hand-sweep.

---

## ✅ CLOSED — build session fixed both audit findings (`77b6596`), verified

- **Steps-1-2 must-fix (delete/archive cascade misses the project):** FIXED + verified. All
  four paths (delete/restore/archive/unarchive) now call `ensureProjectForOpportunity`
  *after* the flag is set, best-effort. Order confirmed correct — the sync re-reads the deal
  (no `deleted_at` filter on either read), sees the just-set flag, and `won` status is
  unchanged so `shouldExist` stays true and the reconcile patch mirrors `deleted_at`/
  `archived_at`. One rule, not four. (Minor nit, not a finding: the 6-line best-effort wrapper
  is duplicated across db.ts `syncArchivedProject` + mutations.ts `syncProjectForOpportunity`
  — cross-module, acceptable.)
- **Step-3 gap (account page's own old-shape deal links):** FIXED + verified. All 12 repointed;
  platform-wide grep now finds **zero** live old-shape `?tab=projects&project=` URLs, and the
  account page carries 17 direct `/commercial/opportunities/…` links. The two anchor-losing
  "jump to invoices/proposals" links went with them.

Both restructure audit findings resolved. Nothing open on steps 1-3 + cleanup.

---

## AUDIT — Step 4 shipped (`24de890`, status path bar + attention). No migration.

**Verdict: strong.** `attention.ts` is excellent and maps straight onto Karan's rules —
warns-never-blocks (`feedback_never_reject_only_warn`, with the concrete win-date reason),
every item names the *consequence* not just the absence, persistent (no dismiss), and
`manualNextStep` returns a move ONLY where the auto-advance engine is structurally blind
(nothing quoted / verbal yes / decide the job started) so the CTA never fights the engine
(my edge-35). `status-path-bar.tsx` is two bars (Sale + Delivery), reads `opp.status`
(correct under today's model (i)), suppresses the CTA once decided/in-delivery, and collapses
to a JS-free `<details>` "Stage N of M" on mobile (Alex's phone). It does NOT show age-in-stage,
so my theme-1 "age freezes at win" concern does not touch this component. Good.

### 🟠 Finding: the "skipped" stage state is scaffolded but never computed (edge 33 not actually done)
`StageState` defines `"skipped"` (and `"dropped"`), `chevronCls` gives skipped a distinct
color, and `Chevron` renders a "skipped" label — but `stateFor` only ever returns
`passed | current | future` (`i < currentIdx ? passed : i === currentIdx ? current : future`).
So **no stage is ever marked skipped**: a deal created/dragged straight to Proposal (skipping
Qualifying/Estimating), or won straight into Billing (skipping Pre-Construction/In-Progress),
renders those stages as **"passed" — a green check — claiming a stage that never happened**,
which is exactly what the component's own comment says is wrong. Edge 33 is therefore not
satisfied despite the scaffolding.

**And it's cheaply fixable NOW** — contrary to my earlier theme-1 note, skipped-detection
does **not** need the (still-absent) project status log: `commercial_opportunity_status_log`
already records every `to_status` transition, so `visited(stage) = a log row exists with
to_status = stage`, and a stage before the current one with no such row is skipped. Wire
`stateFor` to a `visitedKeys` set derived from the opp log (works for both bars today under
model (i)). Until then, either wire it or remove the dead skipped/dropped styling so the code
matches what actually renders. (When delivery moves off the opp in the model-(ii) cutover,
this re-sources to the project log — the theme-1 item.)

---

## AUDIT — Step 5 shipped (`e807cb3`, stage-aware KPIs + compact stats row). No migration.

**Verdict: strong.** `stage-kpis.ts` is a pure, well-tested function and hits my edge-sweep
notes: **no age-in-stage tile** (so the "freezes at win" theme-1 concern does NOT touch this
per-deal strip — that's the list column, a later surface); DST-safe (`daysBetweenEt` slices
Y/M/D and uses `Date.UTC`, never timestamp subtraction); "never 0 days ago"; unset contract
renders "not set" not $0; reads the latest **sent** proposal (a draft revision doesn't reset
the clock); phase-gated fetches so a bid costs no extra round-trips. It also correctly leaves
`decided_at` and `closed_out_at` **raw** (both DATE columns — wrapping them in `etDateOf`
would shift them a day). One bug slipped through in the opposite direction:

### 🟠 Finding: `proposal_due_at` + `follow_up_at` are DATE columns wrongly wrapped in `etDateOf` → off-by-one
`page.tsx:1458-1459` builds the KPI input with `proposalDueAt: etDateOf(opp.proposal_due_at)`
and `followUpAt: etDateOf(opp.follow_up_at)`. But both columns are **DATE**
(`proposal_due_at` mig 028, `follow_up_at` mig 052), and `etDateOf` is for TIMESTAMPTZ — it
does `new Date("2026-08-15").toLocaleDateString(…ET…)`, which parses the date-only string as
**UTC midnight** and converts to ET, landing on **2026-08-14**. Empirically confirmed:
`etDateOf("2026-08-15") === "2026-08-14"`. So the **Proposal due** and **Follow-up** tiles
render one day early, including the tone gates in `dueLabel` — a proposal due **today** shows
**"1 day overdue"**, one due in 4 days shows "in 3 days." That directly contradicts the
commit's headline rule ("counted on Eastern calendar dates"). The neighbours are right for
their types: `rfp_received_at`/`sent_at`/`issued_at` are TIMESTAMPTZ and correctly wrapped.
**Fix:** pass `proposal_due_at` and `follow_up_at` **raw** (exactly as `decided_at`/
`closed_out_at` already are). Platform sweep confirms these are the only two sites.

---

## AUDIT — Step 6 shipped (`deeef3e`, account is a shelf: one deals list, not two). No migration.

**Verdict: clean.** Removing the duplicate Projects tab is right (it was a second view of the
same rows). Verified the two subtle risks are handled: (1) the `?tab=projects` alias
coexists correctly with the step-3 deal-drill-in redirect — `inDealDrillIn` requires a valid
`project=<uuid>`, so `?tab=projects&project=<uuid>` still redirects to the opportunity page
while a bare `?tab=projects` aliases to the deals list (`resolveTabParam` → primary "deals");
(2) the two live links (`post-job-tool-index`, `tool-back-header`) were repointed to
`?tab=deals` directly so nothing relies on the alias, and the archived-settings `#deal-row`
anchor was dropped. `resolveTabParam` is defensively thorough. No orphans (tsc/tests/build green).

### 🟡 Micro-nit: stale breadcrumb LABEL (same-commit partial)
`tool-back-header.tsx:97` repointed the breadcrumb href `?tab=projects → ?tab=deals` in THIS
commit, but the label two lines down (line 99) still reads `"{accountName} · Projects"`, while
that `deals` tab is labeled **"Opportunities"** (`page.tsx:355 { key:"deals", label:"Opportunities" }`).
So the breadcrumb says "· Projects" and lands on a tab titled "Opportunities." Change the
label to "· Opportunities" (and the stale doc-comment at lines 10-11/94 that still says
"account Projects tab"). Low severity, but it's the label-consistency class and it's a
changed-the-href-missed-the-label-below partial.

---

## AUDIT — Step 7 shipped (`37ff210`, saved views + header totals + filter chips). No migration.

**Verdict: strong.** `saved-views.ts` is excellent — views are pure query-param definitions,
the active view is **derived** by exact param match (remove or add a chip → drops to "Custom
filter", round-trip tested), switching clears every view-owned param, the header count/total
come from the SAME array the rows render (no 23-over-19 lie), a TRUE count (no "50+" cap), and
the sum is omitted rather than shown as $0. `activeViewKey`/`viewHref`/`filterChips` are clean.
Age-in-stage reads `listCurrentStatusEnteredAtByOpp` — **correct today** under model (i) (the
opp log still holds delivery transitions); the "freeze at win" is only the future model-(ii)
cutover, already tracked in theme-1. Two things:

### 🟠 Finding: delivery views show + total the BID value, not the project CONTRACT (gap B on the list)
The row shows `bidRange` (`bid_value_low–high`, page.tsx:2139) and the header total sums
`dealValueCents` (page.tsx:696/85) — which is bid-midpoint, or the proposal total, and
**never the contract** (`db.ts:412` reads only `bid_value_*`/proposal). So on the new delivery
views — **Won-not-started / Active projects / Billing** — every row shows its old bid estimate
and the header sums bid midpoints, not the signed contracts that `project.contract_base_cents`
now carries. That undercuts the restructure's own premise ("the price bid is not the contract
delivered") and is a bigger "small lie" than the count-cap the commit meticulously avoided: a
PM scanning Billing backlog sees bids, not contracts. This is the list manifestation of gap B
(the reader-switch) — expected while readers haven't moved to the project column, but it must
land before the list is "done." Cheap first step: `dealValueCents` can prefer
`opp.accepted_contract_cents` (mig 127, already ON the opp) for won/delivery rows without
joining the project.

### 🟡 Sweep note (pre-existing, same class as the step-5 etDateOf bug): raw `Date.now()` age math
`page.tsx:597` (`days since updated`, stale gate) and `:607` (`proposal_due_at` countdown)
subtract raw UTC timestamps (`Date.now() - new Date(x).getTime()`), which drifts up to a day
across the ET offset / DST — and `proposal_due_at` is a DATE column, so `new Date("2026-08-15")`
is UTC midnight. Same class step 5 fixed with `daysBetweenEt`. Coarser here (stale = weeks), so
lower priority, but the overdue/stale gates would be a day off near the boundary. Consider the
ET-calendar helper for these gates too.

---

## AUDIT — Step 8 shipped (`bb63768`, sidebar → 9 destinations; kanban retired). No migration.

**Verdict: clean.** Verified: (1) the kanban BOARD is fully removed with no dead runtime
reference (tsc clean); `?view=kanban` falls to the list, not a 404; `kanban-columns.ts` is
correctly kept (column semantics for list/export/move-API/picker/report — not the board).
(2) The `crewOnly` sidebar branch is untouched — only the main nav sections changed. (3) The
now-unlinked routes still resolve (unlinked, not deleted) and the global Invoices list is NOT
orphaned — reachable via **Reports → AR Aging → Invoices** (`ar-aging/page.tsx:55`) plus the
account-scoped links. No orphans, no broken guards.

**Surfaced to Karan (not a defect):** "Invoices" is no longer a top-level sidebar item —
now per-job (opportunity → Invoices tab) + AR under Reports. He was looking at that page
today, so worth confirming the new home matches intent (it aligns with the "invoices under
the project / AR under Reports" direction). Trivial: the commit title says "eight" but there
are nine destinations.

---

## AUDIT — Step 9 shipped (`380f6a1`, report audit). No migration.

**Verdict: strong, and intellectually honest.** Verified all three claims:
- **"No report groups by owner" — TRUE.** Grep across `app/commercial/reports/` finds zero
  group-by-owner; they group by customer / city+zip / stage / deal→account. So my Review-A
  gap-A (and the edge-sweep group-by-owner concern) was moot for reports, and the build
  session corrected its OWN plan's wrong premise in the doc rather than quietly dropping it.
- **Reports derive contract from the ONE ladder — TRUE.** `listProjects` (job costs +
  geography) calls `pickContractBaseCents` (`db.ts:341`) with `accepted_contract_cents` etc.,
  the same ladder as `getProjectFinancials`. Pipeline correctly stays on weighted/quoted
  (the sales question). Two-amounts drift closed.
- **The contradiction it caught is REAL and the fix is correct.** The attention banner read
  `commercial_projects.contract_base_cents` while the KPI strip six pixels above read the
  ladder — they diverge after award (proposal added to a verbal-yes win → ladder finds it,
  column stays null → "Contract $45,000" above "Contract value isn't set"). Fixed:
  `attentionInput.contractBaseCents = pathFin?.hasContract ? pathFin.contractCents : null`
  (the ladder). One contract figure per page now.

**My own miss — noting it honestly:** this is exactly gap B/C manifesting, and their SELF-audit
caught it, not me. I audited the attention banner (step 4) and the KPI strip (step 5) in
isolation and never cross-checked that the two sourced the contract from *different* places on
the same page. That's the cross-surface check I should have run at step 5. Credit to their
step-9 self-audit.
- **null-opp latent gap:** they recorded my edge-sweep theme-2 finding with the exact tripwire
  (the day T&M-without-a-bid jobs become real) rather than building for it — a reasonable,
  documented deferral since nothing can create a null-opp row today.

### ⚠️ Still open — my step-7 finding is NOT covered by "one source platform-wide"
Step 9 touched only `opportunities/[id]/page.tsx` (the DEAL page) + confirmed the reports. It
did NOT touch `opportunities/page.tsx` (the LIST), where the delivery views (Won / Active /
Billing) still show `dealValueCents` = **bid midpoint**, not the contract ladder. So "one
source platform-wide" holds for reports + the deal page, but the opportunities-list delivery
views remain the exception (step-7 finding). Fold that in to truly be one source everywhere.

---

## AUDIT — Step 10 shipped (`87702e7`, dashboard points at new structure). No migration.

Repointing the 7 retired-route tiles is right, the platform sweep for dead links is good, and
the Settings→Sales-tax "Won opportunity" link fix is a real catch. BUT the headline feature —
the lane filter that makes "the tile and the list it opens describe the same set" — **does the
opposite: the tile and its list disagree at BOTH ends.**

### 🔴 Finding: "Under contract" tile → `?lane=post_contract` list are DIFFERENT sets
- **Tile set** — `production = summarizeProduction(listProjects())`. `listProjects` (`db.ts:109-122`)
  selects `postSale (minus post_sale_closed unless includeClosed) OR (pre_sale_closed AND won)`
  → **won-not-started + pre_construction + in_progress + billing**, **excluding completed**.
- **List set** — `lane=post_contract` = `POST_CONTRACT_COLUMNS` keys =
  **pre_construction + in_progress + billing + post_sale_closed**, and it drops **won**
  (`columnKeyForOpp(pre_sale_closed,"won") = "won"`, which is NOT in that set).
- **Result:** the tile counts won-not-started jobs the list omits, and the list shows completed
  jobs the tile omits. Click "Under contract · $X · N active" and you land on a list with a
  different membership — the precise "tile whose number and destination disagree" the commit
  says it avoided. Worse, the "Under contract" VIEW hint ("awarded and **not yet closed out**")
  describes the *tile* set (won-inclusive, closed-exclusive), contradicting its own
  `lane=post_contract` params.
- **Fix:** make `lane=post_contract` match `production` — include `pre_sale_closed/won`, exclude
  `post_sale_closed` (the "active under contract" set), or thread `includeClosed` consistently.
  One canonical "under contract" predicate shared by the tile, the view hint, and the lane
  filter; today there are three definitions.

---

## AUDIT — `ef94dab` (attention grace periods + drop redundant rule). Clean.

Well-reasoned refinement. Verified: (1) grace math (`daysSince`) uses the ET-calendar
`Date.UTC(slice…)` pattern (same as step-5's `daysBetweenEt`) — NOT raw `Date.now()`; (2)
`decidedAt: opp.decided_at` is passed **raw**, correct because `decided_at` is a DATE column
(wrapping it in `etDateOf` would re-introduce the step-5 off-by-one — they didn't); (3)
no-win-date → `past()` true → surfaces immediately (safe reading of unknown); (4) the
`no_project` warning is correctly NOT grace-gated (a won deal must get its project at once);
(5) dropping "at Proposal with no proposal built" is safe — `manualNextStep` still returns the
"Build a proposal" CTA for that state, so guidance isn't lost, only the wallpaper warning.
Tiny nit (not worth fixing): a future-dated `decided_at` would suppress the graced warnings
(`wonDaysAgo < grace`), but that's a data anomaly.

---

## AUDIT — `47e1618` (status picker offers only engine-blind moves; +mine/new views). Clean.

Well-designed. Verified: (1) `sensibleNextStatuses` returns the correct engine-blind moves per
stage (verbal won/lost, start-the-job, and the manual delivery ladder that has no auto-advance);
(2) the picker keeps the FULL allowed set behind a "show every status" disclosure
(`allOtherStatuses = allowedNextStatuses(...) − sensible`, "(unusual)"-labelled, "use only to
correct it") — respects `feedback_never_reject_only_warn`, corrections stay reachable; (3) the
new `mine`/`new` filters are fully wired — both in `VIEW_OWNED_PARAMS` (clear on view switch),
query-filtered, and chipped; (4) the "New this week" cutoff is ET-anchored and resolves to a
STRING via `.toISOString().slice(0,10)`, so the `created_at.slice(0,10) >= cutoff` compare is
string-vs-string (correct), not Date-vs-string.

Two low nits (not blockers): (a) `created_at` is sliced as UTC while the cutoff is ET-anchored —
a ≤1-day boundary imprecision for late-evening-ET creations on the 7-day window; `etDateOf(created_at)`
would make it exact. (b) `mine` with an unresolved `viewerUserId` falls through to showing ALL
deals under a "Mine" chip — harmless soft-fail, but the chip then lies; consider empty-or-guard.

---

## AUDIT — `070f78b` (FIX 404: mig-127 second FK made proposal embeds ambiguous). Clean + complete.

Serious LIVE bug: every proposal detail page 404'd. Root cause (honestly owned): migration 127's
`accepted_contract_proposal_id` created a SECOND FK between proposals↔opportunities, so every
PostgREST embed between them went ambiguous (PGRST201 → HTTP 300 → null data → the not-found
guard turned it into a 404). A null read is indistinguishable from a missing row, which is why
nothing surfaced it. This is the migration-runtime class I flagged at the start (126-131) — though
it's a mig-127 issue, pre-dating the restructure, that the restructure work happened to expose.

**Fix verified correct + complete.** The 3 broken queries (getProposal + sibling + palette search)
now name the FK explicitly (`commercial_opportunities!commercial_proposals_opportunity_id_fkey`),
verified against a real proposal (200). I independently swept BOTH FK directions — every embed of
`commercial_proposals` and `commercial_opportunities` in lib/ + app/ — and found **zero** remaining
un-disambiguated embeds. Confirmed mig-131's new `project_id` FKs add no new double-FK pair (each
of the 8 delivery tables has a single FK per target), so no further ambiguity. Sweep genuinely
complete. Good catch + honest write-up by the build session.

---

## ✅ CLOSED — Step-10 HIGH fixed (`57f7f16`), verified

The "Under contract" tile↔list mismatch is genuinely resolved:
- `isUnderContract(status, sub)` = `pre_sale_closed/won OR pre_construction OR in_progress OR
  billing` — won-not-started included, completed excluded.
- The LIST's `?lane=under_contract` now filters by `isUnderContract` (page.tsx:657/662); the
  dashboard tiles all link to `?lane=under_contract`.
- The tile's `listProjects` WHERE (`postSale − post_sale_closed OR pre_sale_closed/won`)
  **provably equals** `isUnderContract`'s set. Tile and list now describe the same jobs. ✅
- Param renamed `post_contract → under_contract` (matches the view name); `pre_contract`
  ("Still selling") still works via `PRE_CONTRACT_COLUMNS`.

Three LOW residuals (not blockers): (a) the set is now encoded twice — `listProjects`' SQL
WHERE (tile) and the `isUnderContract` TS predicate (list) — they agree today but could drift;
a shared status-list constant would make them provably one. (b) old `?lane=post_contract` is
now silently ignored rather than aliased (negligible — only internal tiles used it, all
updated). (c) `POST_CONTRACT_COLUMNS` is now an unused import in `opportunities/page.tsx:80`.

## AUDIT — `5597c2f` (slim status picker). Clean cosmetic.
Verified per the "test buttons after a layout change" rule: both actions ("Debrief later"
`type=submit name=debrief_skip`, "Save" `type=submit`) sit in the single
`<form action={changeStatusAction}>` with no nesting, and keep `min-h-[44px] sm:min-h-[36px]`
(mobile target preserved). Removing the persistent amber "valid but unusual" block is correct —
the picker no longer offers unusual moves by default (they're behind the disclosure), and the
per-choice warning on an actual unusual selection stays. Sub-status hints kept visible (no
hover-only, right call for phones). tsc + 385 tests + build green.

---

## AUDIT — `a9fb3b5` (Activity rail: chronology + Upcoming/Overdue). No migration.

**Verdict: strong.** `activity.ts` is pure/testable, reads existing tables with NO store of its
own (edge 40), does its source reads in parallel each `.catch(() => [])`-degrading to empty
(edge 41 — a bad notes query can't take the page down), and is fetched only for the one tab.
The "what's about to be late" math is correct: task `due_at` is a DATE column (mig 031), so
`etDay`'s `slice(0,10)` is the right calendar date, `todayIso = etTodayIso()`, and `daysBetween`
is DST-safe (`Date.UTC` on sliced Y/M/D, not timestamp subtraction). "due today", never "0 days".
Under model (i) the status-log source still carries delivery moves, so the rail shows them today
(the model-(ii) blind-spot stays the tracked theme-1 future item).

### 🟠 Finding: the email archive is NOT read, though the doc + rationale say it is
`loadActivityEntries` does FOUR reads (status log, notes, tasks, proposal milestones) — grep
for `archived_emails`/`email-archive` in `activity.ts` = 0. But the file's own doc says the feed
reads "the status log, notes, tasks **and the email archive**" (l.8), "**Five** reads" (l.120),
and "a chronology missing its **emails**" (l.122), and `ActivityKind` includes `"email"` that is
never produced. Worse, the commit's stated value — *"a job's real story is 'we sent it, she asked
for a revision, we **chased her twice**'"* — is exactly email activity, and it's the one source
omitted. `lib/commercial/email-archive/db.ts` exists and is opp-scoped, so wiring it as the 5th
`.catch(()=>[])` read is straightforward. **Fix:** either add the email-archive source (matches
the doc + the rationale), or correct the doc comments to "four reads" and drop the unused
`"email"` kind. (The commit MESSAGE says "Four reads" — the in-file doc is the stale side.)

### 🟡 Two trivial nits
- `etDay(iso) = iso.slice(0,10)` returns the UTC date, not ET (harmless now — only applied to the
  DATE `due_at` — but the name/comment mislead and it would be off-by-one on any TIMESTAMPTZ).
- Month grouping uses `at.slice(0,7)` = UTC month, so an event in the late-evening-ET window on a
  month's last day groups into the next month. Cosmetic.

---

## AUDIT — `8731b25` (inline field editing). Resolves my earlier business-logic-parity finding.

My follow-up review warned that inline edit needs BUSINESS-LOGIC parity, not just permission +
autosave parity (the "two write paths" class). **The build session resolved it the right way —
by making the allowlist a security boundary that EXCLUDES the side-effect fields**, rather than
replicating their side-effects:
- `status`/`sub_status`, `decided_at`, `accepted_contract_*`, `project_number` are deliberately
  absent (documented, with the reason each has its own writer/cascade). Checked **twice** — at the
  action AND in `updateOpportunityField` (defense against field-name injection). Bare column write
  + `logUpdate`. Server-rendered (no client JS → dodges the React-19 form-reset that bit the
  proposal editor). Validation is real: dates must match `YYYY-MM-DD`, length caps refuse (not
  truncate) an over-long paste, probability 0–100, clear-is-an-edit vs error distinguished.
- **`property_zip` IS allowlisted, and I checked my C3 (tax) concern specifically: it's SAFE.**
  `commercial_opportunities` stores no `tax_pct`; the invoice "new" page reads `opp.property_zip`
  **live** (`invoices/new/page.tsx:127`) and resolves tax from it at creation. So there is no
  stored jurisdiction to go stale — an inline ZIP change flows to the next invoice correctly, and
  the inline + full-edit paths are symmetric. No side-effect to replicate. ✅

**Low nit (pre-existing class, not an inline regression):** `rfp_received_at` is a TIMESTAMPTZ
(mig 069) while the other date fields are DATE. Inline-writing a date-only value to a TIMESTAMPTZ
can round-trip a day off through `etDateOf` depending on the DB session TZ — but the full-edit
form writes it identically (symmetric), and it ties into the step-5 date-type inconsistency
(rfp = TZ, proposal_due/follow_up = DATE). Worth a platform-wide date-type cleanup, not an
inline-specific fix.

---

## ✅ CLOSED — `f15f32d` closes 3 findings (verified)

- **Activity-rail email archive (my finding #2): FIXED.** `loadActivityEntries` now does a 5th
  parallel read — `listArchivedEmails("opp", oppId)` (type-valid, `.catch(()=>[])`) — and emits
  `kind:"email"` entries. The "chased her twice" story now shows.
- **Activity `etDay` "fake ET" (my nit): FIXED.** `etDay` now returns a `/^\d{4}-\d{2}-\d{2}$/`
  date-only string as-is (no false conversion) and converts a real TIMESTAMPTZ to its ET day via
  `Intl.DateTimeFormat(...America/New_York)`; month-grouping follows it. A 9pm-ET event no longer
  slips into the next month.
- **Account-page dead code (build session's own step-3 deferral): DONE.** 687 lines removed
  (7,417→6,772), brace-matched + `type `-prefix-aware so it didn't repeat the sweep that broke
  last time. Independently confirmed: `npx tsc --noEmit` exit 0, 0 errors — no orphaned reference.

**Remaining open after this commit:** step-7 (list delivery views show bid not contract),
step-4 (skipped-stage never computed), step-5 (proposal_due_at/follow_up_at DATE-through-etDateOf
off-by-one). One new LOW: `POST_CONTRACT_COLUMNS` is still a dead import at
`opportunities/page.tsx:80` (the step-10 residual — different file from the account-page sweep).

---

## AUDIT — `50bdd2c` (remove duplicated tiles/toolbar from Karan's smoke test). Correct, 1 straggler.

Karan's smoke test caught real duplication (CONTRACT/WON shown twice; the 6 delivery tools as
both old ProjectToolbar pills AND the new Project sub-tabs) — steps 4-5 built the replacements
and left the originals. Verified the fix removed the RIGHT copies: both KpiTile grids +
ProjectToolbar are gone, the replacements (`StatusPathBar` 1804, `StageKpiStrip` 1894,
`AttentionBanner` 1897) remain, `npx tsc --noEmit` exit 0 / 0 errors — no orphaned reference.
`ProjectStat`/`ToolMiniCard`/`DealPnLView` fully gone (0 occurrences).

**🟡 One straggler:** `function KpiTile` still exists at `opportunities/[id]/page.tsx:5356` with
ZERO render sites — the grids that used it were removed but the component definition was left,
so it's now dead (tsc doesn't error on an unused function). Remove it to match the commit's own
intent (zero dead duplication).

---

## Post-audit punch list (2026-08-12)
Full multi-persona post-audit complete — 47 verified findings (6+ high). See `docs/POST_AUDIT_PUNCHLIST_2026_08.md`. Plus `7e462d9` audit: DATA-LOSS (edit nulls proposed_start/end) + display-still-shows nit, folded into the punch list.

---

## AUDIT — `0da1676` (Brendan's flat stage ladder + estimator trigger). Good fix; 2 path-bar findings STILL open.

**Strong.** Resolves the real complaint ("Pending Approval / Estimating sub-status doesn't move the
bar"): the path bar now renders `PRE_CONTRACT_COLUMNS` via `columnKeyForOpp` — the SAME flat ladder
the list/filters/export/reports use — so it can't diverge from the list again (the two-ladder bug).
Brendan's stages (Qualifying · RFP · Estimating · Pending Approval · Sent · Closed) land with no
migration (old Solicitation/Follow-Up sub-statuses fold into Qualifying/Sent). The estimator-assignment
→ Estimating trigger is well-built: fires only on a newly-*gained* estimator, only from `status==='qualifying'`
(which covers both Qualifying and RFP since RFP is a sub-status), `source:"auto_advance"` so it doesn't
lock the deal, best-effort try/catch. tsc + 408 tests green.

**⚠️ But it rewrote `status-path-bar.tsx` — the exact file with two re-confirmed open findings — and
fixed neither:**
- **Skipped-stage (punch-list HIGH-adjacent / known #3) is STILL open and now WORSE.** `stateFor`
  (138-139) is unchanged: `i < currentIdx ? "passed" : "current"/"future"` — never returns `"skipped"`.
  The ladder went 3→**5** sales stages, so a deal jumped straight to Sent now shows RFP + Estimating +
  Pending Approval as green-check "passed" — claiming an estimator was assigned and a proposal submitted
  for approval, none of which happened. More stages = more false "completed".
- **Won-not-started delivery `currentKey` STILL open.** Line 293 is still `inDelivery ? status :
  "pre_construction"`, so a just-won deal lights Pre-Construction as current (contradicts its own comment).

While you're in this file: wire `stateFor` to a reached-set (the opp status log gives it) so skipped
stages render `"skipped"` not `"passed"`, and pass a sentinel (not null) for won-not-started so the
delivery bar reads all-ahead.

---

## AUDIT — `e68f4c2` ("approved didn't ask won/lost"). Clean.

Correct diagnosis + fix. Approval is INTERNAL (Brendan signs off before the GC sees it), so it rightly
closes nothing — the real gap was "ready to SEND." Verified: (1) `approvedNotSentCount` is wired from
`dealProposals.filter(p => p.status === "approved")` (page.tsx:1504), and `"approved"` is a real
ProposalStatus with a live `pending_approval → approved → (send) → sent` machine (constants.ts:14/85,
db.ts:1410 approveProposal) — so the count matches a genuine approved-but-unsent state, not dead code.
(2) `manualNextStep` ordering is right: Build → **Send it** (110) → Mark won/lost (113), so an approved
-unsent proposal prompts "Send it" and only a SENT one prompts the win/loss decision Karan wanted, at
the point it can be made. (3) The "Approved and not sent" attention item is warn-not-block + names the
consequence. Brendan's 2nd trigger (submit → pending_approval) was verified already-wired, not rebuilt.
tsc + 412 tests (4 new). No new findings.

---

## 🔴 AUDIT — `42ee991` (drop Industry): DATA-LOSS, and it's now a SYSTEMIC pattern (2nd occurrence)

The commit claims "The column stays so nothing already typed is lost." **False — same class as `7e462d9`.**
Confirmed chain:
1. Diff removed the industry `<EditableField>` from the detail page's **identity** section.
2. `accounts/[id]/page.tsx:1197` still builds `industry: get("industry")` in that section's patch; `get()`
   returns **`null`** when the removed input isn't submitted (unlike `company_name`, which uses `?? undefined`).
3. `updateCommercialAccount` (mutations.ts:103) does `.update({ ...patch })` — spreads the whole patch, so
   `industry: null` is written.
→ **Editing the identity section (company name / dba / website) silently NULLs `industry`.** The column
survives the migration but its value is wiped on the next ordinary edit.

**⚠️ SYSTEMIC: this is the 2nd field-removal in a row with the identical defect.** `7e462d9` (proposed
start/end) and `42ee991` (industry) both removed the *input* but left the *patch-builder line*, and both
patch-builders write a non-undefined value → data loss on edit. **Recommend:** (a) fix both; (b) sweep ALL
recent field-drops (probability_pct? the Brendan drops) for a lingering `field: get("field")` / `field: ...?? null`
in a patch that a `.update({...patch})` spreads; (c) adopt the rule: when you remove a field input, remove it
from the patch-builder in the SAME commit (or set it `undefined`, not `null`). Fix here: delete the `industry`
line from the identity patch (1197).

### Two lower incomplete-sweep nits on the same commit
- `accounts/[id]/edit/page.tsx:259` still renders the Industry `<EditField>` — the standalone edit page
  wasn't swept, so Industry is removed from create + detail-inline + list-filter but still editable there.
- `accounts/page.tsx:730` + `1156-1159` still DISPLAY `account.industry` in list rows — the commit removed
  the list *filter* but not the row *display*. Inconsistent with "no longer shown."

---

## AUDIT — `f69d299` (account compliance→prequal + address reorder). Doc retirement right; edit-page NOT swept.

**Done right:** the retired doc categories (COI/W-9/Master/Safety) are kept NAMED so historical uploads
still read (documents.ts) — the correct way to deprecate, and notably NOT the data-loss pattern. The
create form's billing-mirror fallback (`billing_* = same ? get("site_*") : get("billing_*")`,
new/page.tsx:93-96) correctly avoids blanking billing when "same" is checked.

### 🟠 The standalone edit page (`accounts/[id]/edit`) was NOT swept — mislabeled + inverted mirror
`f69d299` inverted the toggle to "billing mirrors COMPANY" and updated the create form + the shared
toggle component's label to "Same as company address". But it did **not** touch `accounts/[id]/edit/page.tsx`
(confirmed: not in the commit's file list). That page is a LIVE form and still runs the OLD direction:
`site_street = get("site_same_as_billing")==='1' ? get("billing_street") : get("site_street")` (110-113,
comment 108 "copy billing → site"). So the shared toggle there now DISPLAYS "Same as company address"
while the server copies **billing → site — the opposite direction** from the create form, and the page
still leads with "Primary Site Address" (old layout). A user editing an existing account gets the inverse
of what the checkbox promises.

### ⚠️ SECOND systemic pattern: the account edit page keeps getting missed
`42ee991` left Industry live on `accounts/[id]/edit`; `f69d299` left the whole address treatment stale
there. The standalone edit page is consistently skipped when the create form + detail-inline sections are
updated → the two edit surfaces diverge. **Recommend retiring `accounts/[id]/edit` and routing all account
editing through the detail-page inline sections** (one edit surface, can't diverge), OR sweeping the edit
page in the SAME commit every time. (Pairs with the first systemic pattern — field-drop data-loss — both
are "the second edit path was left behind.")

---

## AUDIT — `bd1de30` (contacts on new-account form). Clean.

Well-built, and notably more careful than the recent field-drops. Verified: (1) 4 fixed role rows map
to VALID roles (owner→decision_maker, estimating→estimator, billing→billing, field→site; all in
CONTACT_ROLES). (2) Name-required skip (`if (!full_name) continue`) → no nameless contacts from a
stray email/phone. (3) Best-effort: account created first, contacts fail independently, and failures
are genuinely SURFACED not swallowed — `params.set("contacts_failed", …)` → the account page renders
"N contact(s) couldn't be saved — the account was created" (page.tsx:405-406 + the render). (4) Typed
values survive a validation bounce (client component). No new findings.

---

## ⚠️ CORRECTION (verification session, self-audit): my `7e462d9` data-loss finding was WRONG

While auditing `33f764f` I re-checked my own `7e462d9` finding and it does not hold. I claimed editing
a deal nulls `proposed_start_at`/`proposed_end_at`. That rested on an ASSUMPTION I never verified — that
`7e462d9` removed those inputs from the edit SHEET. It did not: `git show 7e462d9` removes no
`name="proposed_start_at"` line, and the edit sheet still renders them **pre-filled**
(`accounts/[id]/page.tsx:6364-6369`, `DateField ... defaultValue={startDateDefault}`). So editing a deal
submits the existing values and `editDealFromAccountAction` writes them back — **no data loss.**
(`updateCommercialOpportunity` *does* write null on a null input — mutations.ts:273-274, so the code
comment at ~1555 claiming "maps null → undefined" is itself wrong — but the input is present, so null is
never submitted.) **Retract punch-list HIGH #7.** proposed_start/end are intentionally create-omitted but
edit-settable ("too early at create, known later") — reasonable, not a bug.

### Consequence: the "systemic data-loss pattern" is ONE confirmed instance, not two
- **`42ee991` Industry: STILL REAL.** Verified again: no `name="industry"` input remains on the detail
  page (the identity `<EditableField>` was removed), the identity-section save still builds
  `industry: get("industry")=null`, and `updateCommercialAccount` spreads `{...patch}` (mutations.ts:103,
  no null→undefined) → editing basic info nulls Industry. This one stands.
- **`7e462d9`: RETRACTED** (above).
So downgrade the claim: the field-drop data-loss is **1 confirmed instance (Industry)**, not a 2-instance
pattern. I over-generalized from one real + one unverified. The SEPARATE "standalone edit page missed"
pattern (Industry left on `accounts/[id]/edit`; inverted address direction there) is unaffected and still
holds (2 instances).

## AUDIT — `33f764f` (opportunity form expanded + reordered). Clean.
Verified: nickname (`title_override`) is wired to BOTH create writers (opportunities/page.tsx:332/401 for
the pipeline quick-create, and the account-scoped form) — the commit genuinely swept both, fixing the
pipeline quick-create that "had drifted" (was dropping nickname/estimator/lead-source). Collapsibles
removed (expanded per Brendan). proposed_start/end removed from CREATE only (harmless — create defaults
null on a new row) while the edit sheet keeps them. No data-loss, no new findings.

---

## AUDIT — `d716179` (team roles → four). Clean.
Right deprecation: `RETIRED_ROLE_LABELS` keeps Account Manager/Superintendent/Foreman/Billing Contact
labels so existing assignments read (not blanks), no migration, no data-loss. Good catch: the `"other"`
fallback (removed with the enum) was repointed to `"sales_rep"` at BOTH write sites (teams/db.ts) — writing
the now-invalid `"other"` would have been a broken write. No findings.

---

## 🤝 COORDINATION NOTE (two sessions auditing — 2026-08-12)
Both the build session and this verification session are auditing. To avoid overlap, one shared truth:

**LANES:** build session = build + self-audit + fixes; verification session (this doc) = verify each fix,
catch 90%-done misses, find edge-cases/data-loss, own the money/date-tz/DB/security punch-list classes.
When you fix a punch-list item, say so in a commit and I'll verify + mark it CLOSED here.

**LIVE STATE of the post-audit punch list (`docs/POST_AUDIT_PUNCHLIST_2026_08.md`):**
- ✅ CLOSED/verified: activity email source, etDay fake-ET, account dead-code, step-10 tile↔list, the
  proposal-page 404 embed (the 3 detail queries).
- ⛔ RETRACTED (do NOT action): punch-list HIGH #7 (7e462d9 proposed-dates data-loss) — was my error.
- 🔴 CONFIRMED-OPEN, highest value (each fixes many): (1) the mig-127 embed ambiguity at the OTHER 7
  sites — Account 360 Proposals tab shows ZERO for every account, + bulk-delete + proposal_idle cron;
  (2) margin basis — stage-KPI strip contract-based vs billed-based everywhere else (D2); (3) platform-wide
  bare-DATE tz off-by-ones (proposal_due/follow_up/Hot/dashboard/fmtEtDate).
- 🔴 OTHER confirmed-open: account Industry data-loss (42ee991); skipped-stage + won-not-started path bar
  (status-path-bar, still open after 0da1676); standalone `accounts/[id]/edit` divergence (Industry +
  inverted address); §7 gaps (retainage, warranty); the mobile 24px touch-target cluster.

If you (build session) pick up any of these, note it so I don't double-audit; I'll verify your fix.

---

## VERIFY — `3e6bd53` (build session's AUDIT round 1: three ladder copies). Fix good; but it was itself 90%-done — 2 MORE copies missed.

The fix is correct for the 3 it names (list-row stepper now derived from shared columns; saved view uses
the canonical stage key; Estimating hint corrected; Pending Approval view added; 2 CI tests pin it). But
the same rename left **two more** stale ladder references the audit missed — same class:

### 🟠 MISS 1 (FUNCTIONAL regression): create picker now offers "Sent" and "Pending Approval" as create stages
`status-sub-status-picker.tsx:69` `CREATE_EXCLUDED_STAGES = ["proposal"]` filters `PRE_CONTRACT_COLUMNS`
by **column key** — but after the rename there is no `"proposal"` key (it's `sent` + `pending_approval`,
confirmed kanban-columns.ts:84-90). So the exclusion now matches nothing, and `CREATE_STAGES` (72) offers
`sent` + `pending_approval` as stages you can create a NEW deal directly at — the exact thing the comment
above it forbids ("You can't have sent a proposal you haven't built"). A user can start a deal already at
"Sent" with no proposal behind it. **Fix:** `CREATE_EXCLUDED_STAGES = ["sent", "pending_approval"]` (both
artifact-requiring stages, not the retired combined key).

### 🟡 MISS 2 (stale label): auto-advance target still labeled "Proposal", not "Sent"
`auto-advance-targets.ts:66` `proposal: { status:"proposal", sub_status:"sent", …, label: "Proposal" }` —
the label wasn't renamed to "Sent" with the column, though its SIBLING (line 64, "Proposal Pending
Approval") was updated. Wherever this target's label surfaces (picker/notification), it reads the old
stage name. **Fix:** `label: "Sent"`.

(Note: most other `"proposal"` literals in the sweep are the still-valid top-level STATUS `"proposal"`
— unchanged by the rename — not stale. These two are the ones keyed on the retired COLUMN name.)

---

## VERIFY — `e7ba2d1` (build's AUDIT round 2). Fixed 2 well; but RE-INTRODUCED the proposed-dates data-loss + left Industry #2 open.

Good fixes: document-category picker extracted to a pure client-importable module (no more hardcoded copy
offering retired COI/W-9/etc. with COI default-selected); Industry removed from the standalone
`accounts/[id]/edit` page. Both real. **But two data-loss issues, same class the commit claims to have
internalized ("every one had a second home"):**

### 🔴 NEW/re-introduced: editing a deal now NULLs `proposed_start_at`/`proposed_end_at`
This commit removed the proposed-start/end INPUTS from the edit sheet (grep for `name="proposed_start_at"`
across the account page = **0**) but LEFT `editDealFromAccountAction` reading them (page.tsx:1572), defaulting
to **null** (1573-1575), and writing them in the payload (1624-1625). `updateCommercialOpportunity` writes
null (mutations.ts:273, `null !== undefined`). → **every edit nulls proposed_start/end.** This is the finding
I RETRACTED earlier — correctly, because at that time the inputs were still present (values preserved). This
commit removing the inputs-without-the-action is what makes it real now. Contradicts "No migration — all data
kept." **Fix:** remove `proposed_start_at`/`proposed_end_at` from `editDealFromAccountAction` (reads 1572-1578
+ payload 1624-1625) too, matching the input removal — or default them `undefined`.

### 🔴 STILL OPEN: Industry identity-section data-loss (`42ee991`) — a DIFFERENT surface than the one just fixed
`e7ba2d1` fixed Industry on `accounts/[id]/edit`, but the DETAIL-page identity SECTION still writes
`industry: get("industry")` (page.tsx:1221) with no industry input in that section → editing basic info still
nulls Industry (`updateCommercialAccount` spreads the null). Fix: drop `industry` from the identity patch.

### The pattern is RECURRING despite awareness → needs a STRUCTURAL guard, not more vigilance
Two rounds of the build session explicitly naming this pattern, and it recurred twice more (proposed-dates,
Industry-identity). Per-instance care isn't holding. **Recommend a test/lint that fails when a patch-builder
writes a column that has no corresponding form input** (the mechanical invariant), and/or collapsing the
duplicate edit surfaces. That kills the class instead of chasing instances.

---

## VERIFY — `e15cc86` (build's AUDIT round 3: un-winning could hide money). Real catch; but the guard misses a SECOND archive path.

The finding + fix are genuinely good: a qualifying deal with 8 invoices (deposit-on-a-handshake) would lose
them when its status changed, because the un-win branch archived the project unconditionally.
`projectHoldsAnything` (iterates all 8 DELIVERY_TABLES, stops at first hit, returns TRUE on read error —
safe) now blocks that. Correct and well-degraded.

### 🟠 MISS: the guard is only on the un-win branch — archiving a WON deal bypasses it
`projectHoldsAnything` gates `ensure.ts:210` (the `!shouldExist` un-win → archive path). But the RECONCILE
branch mirrors `archived_at` UNGATED: `ensure.ts:231` `if (!existing.archived_at && opp.archived_at)
patch.archived_at = opp.archived_at`. And `archiveOpportunity` (db.ts:555 → `syncArchivedProject` →
`ensureProjectForOpportunity`) reaches THIS branch for a still-won deal (shouldExist=true). So **archiving a
won deal that holds invoices mirrors `archived_at` onto its project and drops its money out of every
project-scoped view — the identical hide-money-by-a-flag the fix just closed, on the archive-a-won-deal
path.** (Contingent on the same premise round 3 asserts — that an archived project's money is hidden — which
this fix already accepts.) **Fix:** gate line 231 with `!(await projectHoldsAnything(existing.id))` too, so a
money-holding project stays live even when its deal is archived.

### 🟡 Secondary hardening: `projectHoldsAnything` checks by `project_id` only
If any delivery-artifact writer ever sets `opportunity_id` but not `project_id` (the drift trigger fills the
reverse, not this direction), such a row is invisible to the guard and the project could still be archived
out from under it. Belt-and-suspenders: also check by the project's `opportunity_id`, or assert every
delivery writer sets `project_id`.

---

## VERIFY — `2be8b8a` (round 4: account printed twice). Clean.
Dropped the redundant Account from the step-5 identity row (breadcrumb already shows it, linking the same place); kept the Project NUMBER (unique to the page). Verified: identity row now Project-number-only, breadcrumb account link intact, tsc exit 0 / 416 tests. Correct dedup, no findings. (Also self-checked the mobile table-overflow lane — sound.)

---

## VERIFY — `b883a66` (fix status flow Karan reported: 3 bugs). Correct + complete.
All three verified: (1) `oppStatusDisplayLabel` moved to kanban-columns and now names the STAGE via the
shared mapper (so "RFP"/"Pending Approval" no longer read as their top-level status across the 37 call
sites); (2) `(qualifying,estimating)` and `(estimating,estimating)` both resolve to the Estimating column,
the picker no longer offers the qualifying variant, the tuple stays valid, and — the subtle part — the
estimating column now spans two statuses so it fetches wide + filters in memory. **Miss-check PASSED:** grep
finds NO remaining server-side `.eq("status","estimating")` that would silently drop the (qualifying,estimating)
rows — the fix is complete, not 90%. (3) `sensibleNextStatuses` forward-only (no more double-Qualifying).

### 🔔 REMINDER: my two round-1 misses are STILL OPEN — this commit touched the same file (3rd time) and skipped them
- **FUNCTIONAL:** `status-sub-status-picker.tsx:70` `CREATE_EXCLUDED_STAGES = ["proposal"]` — still the retired
  column key, so it excludes nothing; the CREATE picker still offers "Sent" + "Pending Approval" as stages to
  start a new deal at (no proposal behind it). Fix: `["sent", "pending_approval"]`.
- **LABEL:** `auto-advance-targets.ts:66` still `label: "Proposal"` — should be "Sent".
`status-sub-status-picker.tsx` has now been edited by 0da1676, 3e6bd53, b883a66 without fixing
CREATE_EXCLUDED_STAGES — good candidate to fold into the next status-flow touch.

---

## VERIFY — `5274bba` (RECHECK: one flat stage picker). Correct; fixed 2 of my flags; 3 still open.
Solid. The change-status picker is now ONE flat Stage select whose options derive from the shared columns
and write `COLUMN_TARGET[c.key]` (the same tuple the server action expects) — can't drift, and it offers the
full ladder (both lanes) so corrections still work (never-block preserved). ✅ **CLOSED my round-1 miss #1**:
`CREATE_EXCLUDED_STAGES = ["sent","pending_approval"]` (Sent/Pending-Approval no longer creatable). ✅ Fixed a
4th ladder copy: DELIVERY_STAGES now `POST_CONTRACT_COLUMNS.map(...)` so the bar says "Completed" not "Closed Out".

### 🔔 STILL OPEN (path bar touched AGAIN — 4th time — without them; + my label miss)
- **`status-path-bar.tsx:146`** `stateFor` is STILL `i < currentIdx ? "passed" : …` — never returns "skipped",
  so a jumped stage renders as a green-check "passed" (worse at 5+ stages). [skipped-stage]
- **`status-path-bar.tsx:300`** `currentKey={inDelivery ? status : "pre_construction"}` — a won-not-started
  deal still lights Pre-Construction as current. [won-not-started]
- **`auto-advance-targets.ts:66`** still `label: "Proposal"` — should be "Sent" [round-1 miss #2].
The path bar has now been edited by 0da1676 / b883a66 / 5274bba without the stateFor/currentKey fixes. These
two need a reached-set (opp status log) for stateFor + a sentinel currentKey; fold in on the next path-bar touch.

---

## VERIFY — `4670d98` / migration 132 (13 profiles-embed queries silently empty in PROD). Complete + safe. ✅
Excellent production catch (from Karan's runtime log): 13 queries across 10 files embed `profiles` off a
user_id column via a FK named for auth.users → PGRST200 → silent empty (team lists, notification fan-out, 4
crons, note authors). Same "broken read == no data" shape as the mig-127 404. Migration 132 adds the profiles
FK the code already names, on 4 tables (account/opportunity assignments + account/opportunity notes).

**Miss-check PASSED — I verified completeness + safety, not just plausibility:**
- Swept every `profiles!<fk>` embed in commercial code: all 11 use exactly the 4 FK names mig 132 creates
  (3 acct-assign, 5 opp-assign, 2 opp-notes, 1 acct-notes). Sweep for a 5th/uncovered FK name = **empty** →
  the notification fan-out + all 4 crons resolve through these same FKs. Nothing missed.
- Swept for UNNAMED `profiles(...)` embeds (which mig 132's second FK would make ambiguous — the mig-127 trap
  in reverse) = **empty**. Direct `.from("profiles")` queries aren't embeds and are unaffected.
- Migration is sound: renames (not drops) the auth.users constraint (integrity intact), `ON DELETE SET NULL`,
  unique index on `profiles.user_id`, `NOTIFY pgrst reload`, verified 41 refs/0 orphans, re-runnable.

**ACTION: migration 132 must be applied to prod — the bug is LIVE now** (silent empty team lists + crons
notifying nobody). Applying it fixes all 13 at once; there's no deploy-gate risk (the code is already failing).
