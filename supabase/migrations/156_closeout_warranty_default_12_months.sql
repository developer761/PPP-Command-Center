-- 156 · Close-out warranty term: one default, and it is Tomco's.
--
-- Migration 083 set the column default to 2 years. Every code path that has
-- ever created a package passes 1 explicitly (`createCloseoutPackage`, and the
-- edit form's own fallback), because Tomco's Form of Warranty guarantees the
-- work "for a period of 12 months from the date hereof".
--
-- So the schema disagreed with the business rule AND with the code. It never
-- surfaced only because nothing inserts without the column — which makes it the
-- kind of default that is wrong for a year and then silently doubles a
-- warranty the first time somebody writes a row a different way.
--
-- Existing rows are left alone: a package already sent with a two-year term was
-- sent with a two-year term, and rewriting history under a signed document is
-- worse than an inconsistent past.

ALTER TABLE public.commercial_closeout_packages
  ALTER COLUMN warranty_years SET DEFAULT 1;

COMMENT ON COLUMN public.commercial_closeout_packages.warranty_years IS
  'Warranty term in years. Default 1 = the 12 months Tomco''s Form of Warranty states. Per-job override allowed (0-20).';
