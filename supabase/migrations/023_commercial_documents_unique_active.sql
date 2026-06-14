-- Migration 023: Phase 1 Batch 3 follow-up — prevent concurrent uploads
-- from creating two non-archived documents in the same category.
--
-- Edge case caught in the post-Batch-3 audit (Karan 2026-06-14): if two
-- uploads land for the same (account, category) at the same millisecond,
-- both read the same "prior active" row and both try to archive it AFTER
-- their own row is inserted. Both inserts succeed → two active rows for
-- the same category → the UI picks one arbitrarily and the audit log
-- doesn't clearly say which one is "the" active doc.
--
-- Fix: enforce at the DB layer with a partial unique index. The second
-- concurrent insert fails with a duplicate-key error, the application
-- catches it and retries (or surfaces a friendly "someone else just
-- uploaded — refresh" message).
--
-- Safe to re-run.

CREATE UNIQUE INDEX IF NOT EXISTS commercial_account_documents_one_active_per_category_idx
  ON public.commercial_account_documents (account_id, category)
  WHERE archived = FALSE;
