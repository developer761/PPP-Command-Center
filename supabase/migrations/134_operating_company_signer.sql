-- 134 · Who signs, and as what
--
-- Katie provided Tomco's real "Form of Warranty", and its sign block is:
--
--   By: ______________________
--   Title:    Brendan Dwyer, VP
--   Company:  Tomco Painting
--   Address:  77 Windsor Place, Ste. 13, Central Islip, NY 11722
--   Telephone: 631-582-2770
--
-- Our generated warranty and work order print the signature IMAGE over the
-- company name and the words "Authorized signature" — no person, no title.
-- On a document a GC keeps on file for twelve months against defective work,
-- "Tomco Painting, authorized signature" does not say who stood behind it. The
-- captured template names the signer because that is the point of the block.
--
-- Two columns rather than a free-text block, so the same pair can fill the
-- signature line on the warranty, the work order, and anything signed later
-- (transmittals, lien waivers we sign back, approval sign-offs) without each
-- one inventing its own format.
--
-- Nullable: an operating company with no signer on file keeps today's
-- behaviour exactly — company name plus "Authorized signature" — rather than
-- printing an empty Title line, which would look like a mistake on the page.

ALTER TABLE public.commercial_operating_company
  ADD COLUMN IF NOT EXISTS signature_name  TEXT,
  ADD COLUMN IF NOT EXISTS signature_title TEXT;

COMMENT ON COLUMN public.commercial_operating_company.signature_name IS
  'Person who signs generated documents, e.g. "Brendan Dwyer". Printed above
   the title on the signature block. NULL falls back to "Authorized signature".';

COMMENT ON COLUMN public.commercial_operating_company.signature_title IS
  'That person''s title, e.g. "VP". Printed beside the name, matching Tomco''s
   Form of Warranty sign block.';

-- ── Post-flight ───────────────────────────────────────────────────────────
-- Expect two rows:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'commercial_operating_company'
--      AND column_name IN ('signature_name', 'signature_title');
