-- ────────────────────────────────────────────────────────────────────
-- Migration 064 — Fix TC-WC-002 primer description spacing
-- ────────────────────────────────────────────────────────────────────
-- Karan 2026-07-20: PDF rendered "Prime walls beforewallcovering
-- install." (missing space between "before" and "wallcovering") on a
-- live proposal. Migration 051 seeded the correct string with proper
-- spaces; either the row was hand-edited in Supabase Studio or the
-- form somehow stripped the space. Force-restore the canonical
-- description on rows that match either malformed variant.
--
-- Idempotent — the WHERE clause only touches rows that still have the
-- broken string. Safe to re-run.

UPDATE public.commercial_products
   SET description = 'Prime walls before wallcovering install.'
 WHERE sku = 'TC-WC-002'
   AND deleted_at IS NULL
   AND description IN (
     'Prime walls beforewallcovering install.',
     'Prime walls  wallcovering install.',
     'Prime walls before  wallcovering install.'
   );
