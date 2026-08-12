# Auto-advance engine — audit verdict (2026-08)

Side-by-side audit of the shipped engine (commits `8324a45` stageRank atomic guard,
`5218a2c` four-target whitelist, `61e7a60` forward-only path, migration 126
`status_log` source) against `OVERVIEW_AUTOADVANCE_CLOSED_BUILD_SPEC_2026_08.md` §4
+ the flow-logic findings it touches. 6 lanes + adversarial verify (27 raw).

## ✅ VERDICT: the engine is SOLID — every critical §4 rule verified correct
This was the highest-risk piece (it writes statuses). It was built to spec:

- **§2 stageRank + atomic DB guard** — forward-only is encoded in the **UPDATE's WHERE clause** (`advanceFromFilter` enumerates every state strictly behind the target as a PostgREST `.or()` ANDed onto the id match); 0 rows matched → `skipped:'guard'`. So a concurrent human drag past the target is **not** clobbered — it's a real atomic conditional write, not JS read-then-write. `stageRank` returns null for both terminal off-ramps (lost, fully-closed) and fails closed for unknowns. 31 tests pin the filter.
- **§4b four legal targets** — exactly `draft/pending/approved→Estimating`, `sent→Proposal`, `won→pre_sale_closed·won`, `closeout-complete→closed`, derived from the proposal's *resulting* status via the existing `derive()` map (a fresh draft advances only to Estimating, never Sent — the send-gate holds).
- **§4b dropped triggers ABSENT** — no `won→Pre-Construction`, no `first-invoice→Billing`, no `WO-sent→delivery`. Verified the invoice + WO hooks only `.select()` the opp, never call the engine. Start Project stays manual (so `decided_at`/debrief aren't bypassed).
- **§4d terminal no-op + idempotent atomic + one-write-per-request + no cascade re-entry** — all present. `_skipProposalCascade:true` structurally breaks the proposal↔deal cycle; one write / one log row / one suppressed notification per request.
- **§4d.5 notification suppression + forward-only reconciler** — two-layer: the engine returns `not_behind` before any write in steady state (zero notifications), and the team fan-out is skipped unless `source==='user'`. The **reconciler is now forward-only** — the F7 ping-pong is gone (traced: deal at `proposal·sent` with an open R2 draft → target Estimating, rank 2 !< 1 → `not_behind` → no write; a 25-pass reconcile test asserts it holds), and the prior `acting_user_id:null` whole-team spam on every render is eliminated.
- **F1 (re-quoting a won deal)** — the contract base keys off `proposal.status==='won'` independent of deal status, and the engine mutates only the deal with `_skipProposalCascade`, so opening an R2 draft **cannot strand the signed contract**. (Note: F1's *other* half — the ladder falling to the latest DRAFT — is a separate proposal-cascade bug, still open on the flow-logic list; the engine doesn't worsen it.)
- **F3b + §4c closeout→closed** — edge-triggered on the true into-complete transition only, idempotent, and `decided_at` is **not** clobbered (same terminal top-level status; the `exactFrom` guard blocks any wrong-month source).

## Minor follow-ups (none block the handoff; all low/medium)

### A1. F3c — `decided_at` not restamped on a won↔lost re-decision *(medium, pre-existing, NOT engine-reachable)*
`status.ts:301` stamps only `if (isTerminal && !wasTerminal)`. A manual won↔lost re-decision moves between two `pre_sale_closed` sub-statuses (both terminal), so it's skipped and `decided_at` keeps the stale date — `lost→won` isn't counted in the new period, `won→lost` mis-dates the loss. The engine never targets/sources lost, so it can't hit this, but it's real in `status.ts`.
**Fix:** add `else if (isTerminal && wasTerminal && beforeRow.sub_status !== nextSubStatus) nextDecidedAt = etTodayIso();`

### A2. `markProposalOutcome` is a second deal-state writer *(low regression)*
`proposals/db.ts:820-885` runs the `updateProposalStatus` cascade (which moves the deal through the engine) **and then** a direct `changeOpportunityStatus` with `_skipDagCheck:true`, **no `source`, no forward-only guard**. Its skip-guard covers post-sale but not `pre_sale_closed`, so on a `pre_sale_closed·lost` deal, marking a proposal Won makes the engine correctly no-op (terminal) and then this direct writer flips `lost→won` anyway — the "one authority" rule the engine was built to enforce. Masked in the common paths by the engine's no-op, but a live second writer.
**Fix:** route the won case through `autoAdvanceOpportunity('won')` and drop the redundant write; keep the deliberate lost path (needs `loss_reason`) but pass `source` + a forward-only guard.

### A3. F3a — `decided_at` not stamped on a direct pre-sale→delivery jump *(low, pre-existing, NOT engine-reachable)*
A manual "verbal-yes" jump straight into a delivery stage leaves `decided_at` null → invisible in "Wins this month." The engine caps at `won` (which stamps it), so it can't reach this; only the manual direct jump can.
**Fix:** stamp `decided_at` when entering a delivery stage with it currently null.

## Also confirmed
`foldAutoAdvanceTargets` is defined + tested but wired into no real path (dead but harmless — drop or wire). The F7 "reject dragging to Proposal with an unsent proposal" half lives in the board move-status/WARN path (§5, tracked as R14 in the re-audit) — the reconciler change doesn't regress it, but that half still needs wiring.

## Handoff note
The engine needs **migration 126** applied (the `source` column powers the notification suppression + manual-wins guard). A1/A2/A3 are follow-ups, not blockers.
