-- 150 — RFP is the entry stage; Qualifying is retired
--
-- Brendan 2026-08-17: "I think RFP should be the default stage for a new
-- opportunity. We can remove qualifying from the opportunity. Because
-- technically there is no opportunity if qualifying."
--
-- The lane keeps the `qualifying` STATUS in the database — it is the pre-sale
-- intake lane and renaming a status column value would touch every history
-- row, every status log entry and the CHECK constraint. What changes is the
-- SUB-status: `rfp` is now the entry point and the only offerable option, and
-- the board's "Qualifying" column is gone. `solicitation` stays a legal value
-- so historic status-log rows still validate; it is simply unreachable.
--
-- This moves the live rows so nothing lands on a column that no longer renders.

UPDATE commercial_opportunities
   SET sub_status = 'rfp',
       updated_at = now()
 WHERE status = 'qualifying'
   AND (sub_status = 'solicitation' OR sub_status IS NULL)
   AND deleted_at IS NULL;
