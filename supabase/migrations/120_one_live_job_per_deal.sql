-- 120: enforce ONE live Field Ops job per deal at the DB layer. The invariant was
-- guarded only by read-then-write checks (createJob dupOpp + ensureJobForWorkOrder
-- adopt), which two concurrent sync flows can race past → two live jobs / two job
-- codes for one deal (duplicate calendar cards + split payroll). This partial
-- unique index makes the second insert fail so the code can adopt the winner
-- instead (audit round 8).
--
-- NOTE: this commits the current model to one job per deal. If per-deal PHASES
-- (multiple schedulable jobs per deal) are built later, revisit this index.
-- Idempotent; assumes no existing dups (clean-start module) — dedupe first if the
-- build fails.

create unique index if not exists commercial_jobs_opp_live_uidx
  on public.commercial_jobs (opportunity_id)
  where deleted_at is null and opportunity_id is not null;
