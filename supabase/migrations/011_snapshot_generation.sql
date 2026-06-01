-- Migration 011: snapshot generation counter (cross-server cache coherence)
--
-- The Salesforce snapshot cache lives in two layers: a per-server in-memory
-- Map AND a shared gzipped blob in `snapshot_cache`. After a Salesforce
-- writeback we clear both, but OTHER server instances still hold the stale
-- in-memory copy until their 15-minute TTL expires — so for up to 15 min
-- post-writeback, some admin requests could see stale data.
--
-- This table is a tiny generation counter. clearSalesforceCache() bumps it;
-- on every cached() check, each server reads the current generation (with a
-- 5-second throttle so we don't hammer Postgres). When a server's local
-- cache entry's recorded generation no longer matches the current value, the
-- entry is invalidated immediately and rebuilt — so cross-server cache
-- coherence drops from "up to 15 min" to "5 seconds at most."
--
-- Safe to paste-run multiple times; the table + seed row are guarded.

CREATE TABLE IF NOT EXISTS snapshot_generation (
  key         text        PRIMARY KEY,
  generation  bigint      NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Seed the one row we use ("global"). Idempotent.
INSERT INTO snapshot_generation (key, generation)
VALUES ('global', 1)
ON CONFLICT (key) DO NOTHING;
