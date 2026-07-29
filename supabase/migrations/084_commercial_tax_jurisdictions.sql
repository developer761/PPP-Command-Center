-- Migration 084: NY sales-tax jurisdictions (Sales tax by ZIP).
--
-- Invoices already carry a manual `tax_pct`. This lets the platform AUTO-FILL
-- that rate from the project's ZIP: PPP configures the jurisdictions they work
-- in (name + combined rate + the ZIP prefixes that fall in it), and the invoice
-- form suggests the rate for the project's property ZIP.
--
-- NOTE (deliberate design): we do NOT hardcode NY tax rates in code — rates
-- change and are legally sensitive. PPP owns the data via the admin table +
-- seed rows are flagged in-app to VERIFY before relying on them.
--
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS public.commercial_tax_jurisdictions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL,
  -- Combined state + local rate in THOUSANDTHS OF A PERCENT (8.625% = 8625) so
  -- common NY combined rates keep full precision as integers with no float drift.
  -- 0-20000 guard (0-20%).
  combined_rate_thou  INT NOT NULL CHECK (combined_rate_thou >= 0 AND combined_rate_thou <= 20000),
  -- ZIP prefixes that resolve to this jurisdiction (e.g. {'115','116','117'}).
  -- Longest-prefix match wins in the resolver so overlaps degrade sanely.
  zip_prefixes       TEXT[] NOT NULL DEFAULT '{}',
  -- Operator has confirmed this rate is current (seeded rows start false).
  verified           BOOLEAN NOT NULL DEFAULT FALSE,
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id UUID
);

CREATE INDEX IF NOT EXISTS idx_tax_jur_active ON public.commercial_tax_jurisdictions(active);

ALTER TABLE public.commercial_tax_jurisdictions ENABLE ROW LEVEL SECURITY;
DO $rls$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'commercial_tax_jurisdictions' AND policyname = 'tax_jur_service_role') THEN
    CREATE POLICY tax_jur_service_role ON public.commercial_tax_jurisdictions
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END
$rls$;

-- Seed PPP's likely NY service jurisdictions as a STARTING POINT — verified=FALSE
-- so the app flags them "confirm the current rate" and Katie/Karan adjust. These
-- ZIP prefixes are the common ones; the operator can refine per the admin page.
INSERT INTO public.commercial_tax_jurisdictions (name, combined_rate_thou, zip_prefixes, verified, notes)
SELECT * FROM (VALUES
  ('New York City (all boroughs)', 8875, ARRAY['100','101','102','103','104','111','112','113','114'], FALSE, 'NYC combined rate. Verify current rate + confirm the ZIP set for the boroughs you work.'),
  ('Nassau County', 8625, ARRAY['110','115','116','1180','1181'], FALSE, 'Long Island — Nassau. Verify rate + ZIP prefixes (11001-11599 range).'),
  ('Suffolk County', 8625, ARRAY['117','118','119'], FALSE, 'Long Island — Suffolk. Verify rate + ZIP prefixes.')
) AS v(name, combined_rate_thou, zip_prefixes, verified, notes)
WHERE NOT EXISTS (SELECT 1 FROM public.commercial_tax_jurisdictions);
