-- 162 · Bill the retainage as its own application. (Stephanie, 2026-08-17)
--
-- HER NOTE: "we need to bill for the retainage, can we add the retainage AIA as
-- they always pay it separately and months after the job is finished."
--
-- She is describing the Application for Final Payment. On a G702 the retainage
-- is not a separate invoice — it is a final application on the SAME contract
-- with retainage at 0%, which is what releases the money already earned but
-- held back:
--
--   line 4  Total Completed & Stored ....... unchanged (the work is done)
--   line 5  Retainage ...................... 0        <- released here
--   line 6  Total Earned Less Retainage .... now the full contract
--   line 7  Less Previous Certificates ..... everything certified so far
--   line 8  CURRENT PAYMENT DUE ............ exactly the retainage held
--
-- So the arithmetic already works: computeG702 with retainage_pct = 0 over the
-- carried-forward schedule of values produces the held retainage on line 8, with
-- no new math and no second money path to reconcile. What was missing is a way
-- to SAY that is what this application is.
--
-- WHY A FLAG AND NOT retainage_pct = 0 ALONE. A job that never held retainage
-- also runs at 0%, so the percentage cannot distinguish "no retainage on this
-- contract" from "this is the release". The flag lets the list, the detail
-- header and the G702 PDF title it as the final payment application rather than
-- showing an ordinary requisition that happens to have a zero on line 5 — and
-- lets us refuse a second one.

ALTER TABLE commercial_aia_applications
  ADD COLUMN IF NOT EXISTS is_retainage_release boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN commercial_aia_applications.is_retainage_release IS
  'This application releases held retainage (Application for Final Payment): retainage_pct is 0 and line 8 equals the retainage held. At most one per opportunity.';

-- One release per job. A second would bill retainage that is already released:
-- line 7 would carry the first release forward, so line 8 would come out at
-- zero — a certificate for nothing, sent to a GC. Partial index so the
-- constraint only covers releases and ordinary applications are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS commercial_aia_one_retainage_release_per_opp
  ON commercial_aia_applications (opportunity_id)
  WHERE is_retainage_release AND deleted_at IS NULL;
