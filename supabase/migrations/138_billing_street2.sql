-- 138 — a second billing address line.
--
-- Stephanie 2026-08-13: "Accounts > Billing Address - add 2nd line for
-- floor/ unit/ ste."
--
-- Commercial GCs are in office buildings, so "Suite 400" / "3rd Floor" is
-- the norm, not the exception. Without a field for it, it gets appended to
-- the street line — which then reads badly on the proposal letterhead and
-- makes the address autocomplete fight the user, because the widget
-- overwrites line one with its own formatted street.
--
-- Deliberately optional and never derived: an address line 2 is the one part
-- of an address no geocoder can supply, so it is always typed by hand.

-- Both addresses get the line, not just billing. The Street/City/State/ZIP
-- block is ONE shared component used for billing and site alike, so adding
-- the input adds it to both — and an input with no column behind it accepts
-- what someone types and silently discards it. A job site has floors and
-- units for the same reason an office does.
alter table commercial_accounts
  add column if not exists billing_street2 text,
  add column if not exists site_street2 text;

comment on column commercial_accounts.billing_street2 is
  'Second billing address line — floor / unit / suite. Typed by hand; never filled by address autocomplete.';
comment on column commercial_accounts.site_street2 is
  'Second site address line — floor / unit / suite. Typed by hand; never filled by address autocomplete.';
