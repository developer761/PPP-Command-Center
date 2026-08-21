-- 163 · Lien waiver against an AIA application. (Stephanie, 2026-08-20)
--
-- HER NOTE: "Add lien waiver option to AIA billing just as it is under the
-- invoicing."
--
-- Same shape as commercial_invoices.lien_waiver_document_id (migration 118):
-- the file is stored ONCE as a per-deal document with category 'lien_waiver',
-- and this column links the application to it. Storing rather than generating
-- is deliberate and predates this — Katie's rule: the GC sends the waiver, we
-- sign and return it, and the platform keeps the copy. We do not produce them.
--
-- Why AIA needs its own link rather than leaning on the invoice's: on a
-- progress-billed job the requisition IS the payment request. Each application
-- gets its own partial waiver for that period, and the final one gets the
-- final waiver — which is exactly the pairing Katie described ("final bill sent
-- WITH a final lien waiver"). Hanging them all off invoices would leave the
-- waiver for Application No. 3 filed under whichever invoice happened to exist.
--
-- ON DELETE SET NULL, matching the invoice column: deleting the document from
-- the Documents tab must not delete the certificate that referenced it.

ALTER TABLE commercial_aia_applications
  ADD COLUMN IF NOT EXISTS lien_waiver_document_id uuid
  REFERENCES commercial_documents(id) ON DELETE SET NULL;

COMMENT ON COLUMN commercial_aia_applications.lien_waiver_document_id IS
  'The signed lien waiver covering this application''s payment. Points at a commercial_documents row (category lien_waiver) on the same deal. Stored, never generated.';

CREATE INDEX IF NOT EXISTS commercial_aia_applications_lien_waiver_idx
  ON commercial_aia_applications (lien_waiver_document_id)
  WHERE lien_waiver_document_id IS NOT NULL;
