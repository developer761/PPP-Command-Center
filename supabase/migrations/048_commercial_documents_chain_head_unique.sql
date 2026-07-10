-- 048_commercial_documents_chain_head_unique.sql
--
-- Phase C follow-up (audit fix) — prevent two competing "current" versions
-- when two users hit "New version" on the same previous doc at the same
-- time.
--
-- Race today: bumpDocumentVersion reads prev, uploads new doc, links
-- new.parent_document_id = prev.id, demotes prev to superseded. If two
-- users race, both new rows insert with parent_document_id = prev.id →
-- two heads, one parent. Confusing but not fatal.
--
-- Fix: partial UNIQUE index on parent_document_id where the child is
-- still alive (not soft-deleted). At most one active child per parent
-- means the second racer's version-link UPDATE fails, and the caller
-- can present a friendly "someone else uploaded a new version — refresh
-- to see" message.
--
-- Idempotent, rerun-safe.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_commercial_documents_one_child_per_parent
  ON public.commercial_documents (parent_document_id)
  WHERE parent_document_id IS NOT NULL AND deleted_at IS NULL;

DO $$
BEGIN
  RAISE NOTICE 'commercial_documents chain-head UNIQUE ready';
END $$;

COMMIT;
