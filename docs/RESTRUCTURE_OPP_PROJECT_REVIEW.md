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
