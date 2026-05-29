-- 011_snapshot_cache.sql
-- Shared, cross-instance cache for the Salesforce snapshot (speed fix #150).
--
-- The admin dashboard builds one big snapshot (~89k opps + 88k WOs) by paging
-- Salesforce ~45 times — 8-15s cold. The existing 15-min cache is in-memory
-- PER serverless instance, so new/cold instances keep re-paying that cost.
-- This table lets every instance read a finished, gzipped snapshot blob that
-- ONE instance computed, instead of re-querying Salesforce.
--
-- SAFETY: the app treats this as a pure optimization. If the table is missing,
-- stale, oversized, corrupt, or unreachable, loadSalesforceSnapshot() falls
-- back to the live Salesforce query (exactly today's behavior). So it's safe
-- to deploy the code before this migration runs — the reads/writes just no-op.
--
-- IF NOT EXISTS so re-running is a no-op (no migration runner — pasted by hand).

create table if not exists snapshot_cache (
  key          text primary key,         -- e.g. "snapshot-v5"
  payload_gz   text not null,            -- gzip(JSON) base64-encoded
  fetched_at   timestamptz not null default now(),
  expires_at   timestamptz not null
);

-- Service-role only (the app reads/writes via the Supabase service key, same
-- as every other server-side table). No RLS policies needed since the anon
-- key never touches this table.
