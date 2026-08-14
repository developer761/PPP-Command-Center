-- 145 — a phone number the supplier can actually call.
--
-- Kate round-3 #29: "The order email gives the supplier no way to reach anyone.
-- If a color is unavailable, a quantity looks wrong, or the pickup time doesn't
-- work, there's nothing on the email to call."
--
-- We hold no phone number for anyone today, so this is the storage half. It is
-- deliberately per USER rather than a single PPP switchboard number: the contact
-- Kate asked for is "the person placing the paint order", so the default has to
-- follow whoever is signed in.
--
-- The order form defaults to this value and lets it be changed per order
-- WITHOUT writing back here — a one-off "call me on my cell for this job"
-- shouldn't silently rewrite someone's stored number.

alter table public.profiles
  add column if not exists phone text;

comment on column public.profiles.phone is
  'Contact number for this user, captured at account setup. Defaults the "who to call" field on supplier orders; per-order edits do not write back here. Kate round-3 #29.';
