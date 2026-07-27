-- 078_commercial_invoice_next_number.sql
-- Fix sequential invoice numbering (Karan 2026-07-27 audit, Lane E).
--
-- nextInvoiceNumber() called `rpc("nextval", { seq_name })`, but there is no
-- public.nextval(text) wrapper — the built-in nextval takes a regclass and
-- pg_catalog isn't exposed to PostgREST. So every call errored and fell back to
-- a random base36 suffix (INV-K3F9Z2) instead of the intended INV-0001 scheme,
-- and commercial_invoice_seq was never advanced.
--
-- This adds a SECURITY DEFINER wrapper the app can call by name.

CREATE OR REPLACE FUNCTION public.commercial_next_invoice_seq()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT nextval('public.commercial_invoice_seq');
$$;

-- The service-role client already has execute; this is explicit + harmless.
GRANT EXECUTE ON FUNCTION public.commercial_next_invoice_seq() TO service_role;
