-- Commercial vendor directory (Katie 2026-09-15).
--
-- "Add all vendors — both retail vendors and labor vendors (run a vendors
-- report for Tomco jobs in SF since last year to make sure we have all the
-- vendors that they regularly use)."
--
-- Until now a purchase's vendor was free text, so "Sherwin Williams",
-- "sherwin-williams" and "SW" were three vendors and a crew member typed the
-- name from memory on every receipt. This adds:
--
--   1. commercial_vendors — the directory. Two kinds:
--        retail = stores, suppliers, rental yards (what we BUY from)
--        labor  = Tomco crew payees, labor companies, subs (who we PAY for work)
--      Never hard-deleted: deactivate hides a vendor from the purchase picker
--      and keeps every past purchase pointing at it. deleted_at exists for
--      parity with the other commercial tables; the app never sets it.
--
--   2. commercial_project_purchases.vendor_id — a nullable link. The `vendor`
--      text column STAYS and is still written on every save (as the vendor's
--      directory name), so the vendor-spend report, the transactions report,
--      reimbursements and every old free-text purchase keep working unchanged.
--
--   3. The seed: 44 vendors (28 retail, 16 labor) cleaned from the Salesforce
--      export tomco_vendors_since_2025.csv (54 rows) by
--      lib/commercial/vendors/sf-seed.ts via
--      scripts/build-commercial-vendor-seed.mjs. Dropped: the 4 catch-all
--      placeholders (Retail Vendor, Gas Station, Restaurants, Supermarket) and
--      the reimbursement-only payees (Precision Painting Plus LLC, TLA
--      Contracting, ART). Merged: GTS Builders Supply (3 SF accounts) and SP
--      Sign Warehouse (2) — every SF id is kept in sf_account_ids. No SSN, EIN,
--      bank or password data: the export carries none.
--
-- ⚠ TEST-DATA WIPE MUST KEEP commercial_vendors. It is configuration, like
--   products and competitors — scripts/wipe-commercial-data.sql lists it under
--   KEPT and never deletes from it. Wiping purchases leaves it intact (the FK is
--   on the purchase side, ON DELETE SET NULL from the vendor side).
--
-- Service-role only (RLS on, no policies), like every commercial_* table: all
-- reads and writes go through server code that has passed the commercial gate.
--
-- Safe to re-run end to end. The seed skips any vendor already present by SF
-- account id OR by name (case-insensitive), so a vendor renamed or deactivated
-- in the app is never re-added or reactivated.

create table if not exists public.commercial_vendors (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null check (length(btrim(name)) > 0),
  kind                text not null check (kind in ('retail','labor')),
  status              text not null default 'active' check (status in ('active','inactive')),
  -- What they sell or do ("Paint", "Equipment Rental") — the picker's hint line.
  specialty           text,
  contact_name        text,
  phone               text,
  email               text,
  website             text,
  address_line1       text,
  city                text,
  state               text,
  zip                 text,
  payment_terms       text,
  preferred_payment   text,
  w9_on_file          boolean not null default false,
  compliance_status   text,
  notes               text,
  -- Every Salesforce Account id this vendor was merged from.
  sf_account_ids      text[] not null default '{}',
  created_by_user_id  uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);

-- One live vendor per name, case-insensitively. A second "home depot" is the
-- exact split this directory exists to stop.
create unique index if not exists commercial_vendors_name_live_uniq
  on public.commercial_vendors (lower(name)) where deleted_at is null;

create index if not exists commercial_vendors_kind_status_idx
  on public.commercial_vendors (kind, status) where deleted_at is null;

drop trigger if exists commercial_vendors_set_updated_at on public.commercial_vendors;
create trigger commercial_vendors_set_updated_at
  before update on public.commercial_vendors
  for each row execute function public.tg_commercial_set_updated_at();

alter table public.commercial_vendors enable row level security;

comment on table public.commercial_vendors is
  'Tomco vendor directory (retail + labor). Configuration — the commercial test-data wipe must KEEP it. Deactivate, never delete.';

-- ── Purchases → vendor link ────────────────────────────────────────────────
alter table public.commercial_project_purchases
  add column if not exists vendor_id uuid references public.commercial_vendors(id) on delete set null;

create index if not exists commercial_project_purchases_vendor_idx
  on public.commercial_project_purchases (vendor_id) where vendor_id is not null;

comment on column public.commercial_project_purchases.vendor_id is
  'Directory vendor, when picked. The vendor text column is still written (as the directory name) so name-grouped reports and old free-text rows keep working.';

-- ── Seed ───────────────────────────────────────────────────────────────────
insert into public.commercial_vendors (
  name, kind, status, specialty, contact_name, phone, email, website,
  address_line1, city, state, zip, payment_terms, preferred_payment,
  w9_on_file, compliance_status, notes, sf_account_ids
)
select s.*
from (values
  ('7 Eleven', 'retail', 'active', 'Convenience Store', NULL, '(212) 260-0529', NULL, NULL, '351 Bowery', 'New York', 'NY', '10003', NULL, NULL, false, NULL, NULL, ARRAY['0016g00002elK9TAAU']::text[]),
  ('Aboffs', 'retail', 'active', 'Paint', NULL, NULL, NULL, NULL, NULL, NULL, 'NY', NULL, 'Upon Receipt', NULL, false, NULL, 'Acct #917-886-8114 (Alex''s)', ARRAY['0016g00002idAD7AAM']::text[]),
  ('Ace Hardware', 'retail', 'active', 'Hardware/Locksmith', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['0016g00002iwIjHAAU']::text[]),
  ('Ace Hardware-Costello''s', 'retail', 'active', 'Hardware/Locksmith', NULL, '(631) 650-6914', NULL, NULL, '15 W Main Street', NULL, 'NY', '11730', NULL, NULL, false, NULL, NULL, ARRAY['0016g00002elKDwAAM']::text[]),
  ('All Island Hardwood Flooring', 'retail', 'active', 'Flooring', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['0016g00002elKIUAA2']::text[]),
  ('Alpers True Value Hardware', 'retail', 'active', 'Hardware/Locksmith', NULL, NULL, NULL, NULL, '81 Main street', NULL, 'NY', '11050', NULL, NULL, false, NULL, NULL, ARRAY['0016g00002idADEAA2']::text[]),
  ('Amazon.com', 'retail', 'active', 'Other', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['0016g00002idAFxAAM']::text[]),
  ('Automatic Repair Company', 'retail', 'active', 'Service Vendors', NULL, '(631) 420-0103', NULL, NULL, '131 Florida St', 'Farmingdale', 'NY', '11735', NULL, NULL, false, NULL, NULL, ARRAY['0016g00002elKE2AAM']::text[]),
  ('Blick Art Materials', 'retail', 'active', 'Project Materials', NULL, '(212) 924-4136', NULL, NULL, '21 E 13th Street', 'New York', 'NY', NULL, NULL, NULL, false, NULL, 'SF "ART" (001Kf00001CtIPqIAN) is probably this store — same $26.70 amount, and created in the same 2025-09-10 batch as the GTS and SP Sign reimbursement duplicates', ARRAY['0016g00002elKHoAAM']::text[]),
  ('Brinkmann''s Hardware', 'retail', 'active', 'Hardware/Locksmith', NULL, '(631) 589-2462', 'desk@brinkmannsenterprises.com', NULL, '226 Railroad Ave #100', NULL, 'NY', '11782', NULL, NULL, false, NULL, NULL, ARRAY['0016g00002elKEJAA2']::text[]),
  ('Cassone Leasing Inc', 'retail', 'active', NULL, NULL, '(631) 585-7800', NULL, NULL, NULL, NULL, NULL, NULL, 'Upon Receipt', NULL, false, NULL, NULL, ARRAY['001Wj00001lfKNSIA2']::text[]),
  ('Dunrite', 'retail', 'active', NULL, NULL, '(631) 585-1618', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['001Kf00001DWCKRIA5']::text[]),
  ('East Islip Lumber Company', 'retail', 'active', 'Building Supply', NULL, '(631) 581-1869', NULL, NULL, '33 Wall Street', 'East Islip', 'NY', '11730', 'Upon Receipt', NULL, false, NULL, NULL, ARRAY['001Wj00001W5yn2IAB']::text[]),
  ('GTS Builders Supply', 'retail', 'active', 'Building Supply', NULL, '(631) 585-7171', NULL, NULL, '4701 Veterans Memorial Highway', 'Holbrook', 'NY', '11741', 'Upon Receipt', NULL, false, NULL, NULL, ARRAY['001Kf00001DW9WcIAL', '001Wj00001AVOkkIAH', '001Kf00001CtH7iIAF']::text[]),
  ('Harbor Freight', 'retail', 'active', 'Project Materials', NULL, '(631) 423-2951', NULL, NULL, '301 w jericho tpke', 'Huntington Station', 'NY', '11746', NULL, NULL, false, NULL, NULL, ARRAY['0016g00002elKIBAA2']::text[]),
  ('Home Depot', 'retail', 'active', 'Project Materials', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['0016g00002idAD8AAM']::text[]),
  ('L.I. Hardware', 'retail', 'active', 'Hardware/Locksmith', NULL, '(631) 467-1316', NULL, NULL, '3606 Veterans Highway', 'Bohemia', 'NY', '11716', NULL, NULL, false, NULL, NULL, ARRAY['0016g00002elKDrAAM']::text[]),
  ('Lowe''s', 'retail', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['0016g00002iwJFvAAM']::text[]),
  ('Sherwin Williams', 'retail', 'active', 'Paint Stores', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['0016g00002iHaUOAA0']::text[]),
  ('Signarama', 'retail', 'active', NULL, NULL, '(631) 471-2939', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['001Kf00001DW3PZIA1']::text[]),
  ('SP Sign Warehouse', 'retail', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['001Kf00001DWAICIA5', '001Kf00001CtHBPIA3']::text[]),
  ('Sunbelt Rentals', 'retail', 'active', 'Equipment Rental', NULL, NULL, NULL, NULL, '3665 Expressway dr. north', NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['0016g00002idAHUAA2']::text[]),
  ('United Rentals', 'retail', 'active', 'Equipment Rental', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['0016g00002idAEtAAM']::text[]),
  ('USPS', 'retail', 'active', 'Shipping', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['0016g00002elKJGAA2']::text[]),
  ('Wallauer Paint & Decorating', 'retail', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'NY', NULL, NULL, NULL, false, NULL, NULL, ARRAY['0016g00002idAEfAAM']::text[]),
  ('Walmart', 'retail', 'active', 'Discount Store', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['0016g00002idAEnAAM']::text[]),
  ('Willis Paint Place', 'retail', 'active', 'Paint', NULL, '(516) 621-3772', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['0016g00002idKIcAAM']::text[]),
  ('Wolf Gordon', 'retail', 'active', NULL, NULL, NULL, NULL, NULL, '33-00 47th Ave', 'Long Island City', 'NY', '11101', NULL, NULL, false, NULL, NULL, ARRAY['0016g00002idAIgAAM']::text[]),
  ('LC Alex Steve Wagner', 'labor', 'active', NULL, 'Stephanie Bevilacqua', '(516) 262-0632', 'galacticpunk75@gmail.com', NULL, '2882 Dahlia Avenue', 'Baldwin', 'NY', '11510', NULL, 'ACH', true, NULL, 'Legal name: Stephanie Bevilacqua · Subcontractor agreement signed 2025-03-05 · Direct deposit set up in SF', ARRAY['0016g00002elKGuAAM']::text[]),
  ('LC Brendan Dwyer', 'labor', 'active', NULL, 'Brendan Dwyer', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['0016g00002elKHiAAM']::text[]),
  ('LC Cristhian Plaza', 'labor', 'active', NULL, 'Cristhian Plaza', '(347) 370-8693', 'cristhian@precisionpaintingplus.net', NULL, '1200 Jericho Turnpike', 'Westbury', 'NY', '11590', NULL, NULL, true, NULL, 'Legal name: KCP Painting & Contracting Inc · Subcontractor agreement signed 2016-10-26 · Needs a check: SF lists a precisionpaintingplus.net email and a Westbury address for this sub — confirm they are the sub''s own details.', ARRAY['0016g00002elK2FAAU']::text[]),
  ('LC RA Jose', 'labor', 'active', NULL, 'Jose Monroy Salvador', '(516) 673-5595', 'rajosemanagementcorp@gmail.com', NULL, '21 Rhodes Ave', 'Bay Shore', 'NY', '11706', NULL, 'ACH', true, NULL, 'Legal name: RA Jose Management Corp · Subcontractor agreement signed 2025-03-25 · Direct deposit set up in SF', ARRAY['0016g00002elK2OAAU']::text[]),
  ('LC Ricardo Masterwallpaper NYC', 'labor', 'active', NULL, 'Javier Ricardo Velez Gomez', '(516) 984-5053', 'velez-1979@hotmail.com', NULL, '55 Cleveland Pl', 'Massapiqua', 'NY', '11758', NULL, 'ACH', true, NULL, 'Legal name: Masterwallpaper · Subcontractor agreement signed 2025-02-18 · Direct deposit set up in SF', ARRAY['0016g00002elK2ZAAU']::text[]),
  ('Omar LI', 'labor', 'active', NULL, 'Omar Flores', '(631) 627-5798', 'sorianopainting278@gmail.com', NULL, NULL, NULL, NULL, NULL, NULL, 'ACH', true, NULL, 'Legal name: Custom Quality Painting Inc · Subcontractor agreement signed 2025-02-19 · Direct deposit set up in SF', ARRAY['0016g00002lGVIsAAO']::text[]),
  ('Tomco Labor', 'labor', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'ACH', false, NULL, 'Needs a check: SF''s generic "Tomco Labor" payee names no individual. If it is a catch-all rather than a real payee, deactivate it so labor gets logged to the person.', ARRAY['001Kf00001EdKdkIAF']::text[]),
  ('Tomco Labor - Carlos', 'labor', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['001Kf00001Dai2UIAR']::text[]),
  ('Tomco Labor - Erick', 'labor', 'active', NULL, NULL, NULL, NULL, NULL, '2929 East Commercial Boulevard, #205', 'Fort Lauderdale', 'FL', '33308', NULL, NULL, false, NULL, NULL, ARRAY['001Kf00001E2uAJIAZ']::text[]),
  ('Tomco Labor - Greg', 'labor', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['001Kf00001CXL8tIAH']::text[]),
  ('Tomco Labor - JJ', 'labor', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['001Kf00001DagOKIAZ']::text[]),
  ('Tomco Labor - Joe', 'labor', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['001Kf00001DagUMIAZ']::text[]),
  ('Tomco Labor - Keith', 'labor', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'Upon Receipt', NULL, false, NULL, NULL, ARRAY['001Wj00001PCKwvIAH']::text[]),
  ('Tomco Labor - Miguel', 'labor', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['001Kf00001DagUNIAZ']::text[]),
  ('Tomco Labor - Rob', 'labor', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['001Kf00001DagrBIAR']::text[]),
  ('Tomco Labor - Robert P', 'labor', 'active', NULL, 'Robert Patterson', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['001Wj00000yBHiwIAG']::text[])
) as s (
  name, kind, status, specialty, contact_name, phone, email, website,
  address_line1, city, state, zip, payment_terms, preferred_payment,
  w9_on_file, compliance_status, notes, sf_account_ids
)
where not exists (
  select 1 from public.commercial_vendors v
  where v.sf_account_ids && s.sf_account_ids
     or lower(v.name) = lower(s.name)
)
on conflict do nothing;

-- ── Backfill: link existing purchases whose text is exactly a vendor name ──
-- Harmless by construction: only fills a NULL vendor_id, only on an exact
-- case-insensitive name match to a live vendor, and never touches the text.
-- (At the time of writing there are no live purchases — test data only.)
update public.commercial_project_purchases p
set vendor_id = v.id
from public.commercial_vendors v
where p.vendor_id is null
  and p.vendor is not null
  and lower(btrim(p.vendor)) = lower(v.name)
  and v.deleted_at is null;
