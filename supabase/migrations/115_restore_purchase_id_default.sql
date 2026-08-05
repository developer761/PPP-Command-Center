-- 115 . Restore the id default on commercial_project_purchases.
-- 095 set `id uuid default gen_random_uuid()`, but on prod the default is
-- missing (a cost insert failed the NOT NULL constraint) — likely a corrupted
-- paste of 095. The app now supplies the id in code, so this is belt-and-
-- suspenders: it makes any future insert path safe too. Idempotent + harmless.

alter table public.commercial_project_purchases
  alter column id set default gen_random_uuid();
