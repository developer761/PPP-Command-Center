-- Payments recorded against an AIA application.
--
-- Stephanie 2026-09-24: "At times we would need to record multiple payments
-- against 1 AIA." And, the day before: "when I went into record the payment,
-- it didn't show up on the list because it was billed as AIA."
--
-- Until now an AIA application had a `status` and nothing else. Marking it
-- 'paid' asserted that the whole of G702 line 6 (Total Earned Less Retainage)
-- had arrived, on a date nobody recorded, by a method nobody recorded. Every
-- rollup then INFERRED collected from that flag. It got the total right and
-- lost everything else: no check number, no deposit date, and no way to say
-- "they paid half of Application 3."
--
-- This is the same shape as commercial_invoice_payments, deliberately — the
-- two ledgers should read the same way, and Mary and Stephanie should not have
-- to learn two vocabularies for "we got paid."
--
-- Note what is NOT here: no paid_cents cache on the application. The sum of
-- these rows IS the amount collected. A cached total is one more thing that
-- can disagree with the rows underneath it, and this platform has already paid
-- for that lesson elsewhere.

create table if not exists public.commercial_aia_payments (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null
    references public.commercial_aia_applications (id) on delete cascade,
  amount_cents bigint not null check (amount_cents > 0),
  paid_at timestamptz not null default now(),
  method text,
  reference text,
  notes text,
  -- The signed waiver that arrived with this progress payment, when there is
  -- one. Mirrors commercial_invoice_payments.lien_waiver_document_id.
  lien_waiver_document_id uuid
    references public.commercial_documents (id) on delete set null,
  deposited_at timestamptz,
  recorded_by_user_id uuid references public.profiles (user_id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.commercial_aia_payments is
  'Money received against one AIA application. Multiple rows per application are expected — a GC part-paying a certificate is normal. Stephanie 2026-09-24.';

-- Every read is "the payments on this application", and every one of them
-- filters out the soft-deleted.
create index if not exists commercial_aia_payments_application_idx
  on public.commercial_aia_payments (application_id)
  where deleted_at is null;

-- The AR and cash-flow reports slice by when the money landed.
create index if not exists commercial_aia_payments_paid_at_idx
  on public.commercial_aia_payments (paid_at)
  where deleted_at is null;

alter table public.commercial_aia_payments enable row level security;

-- Same posture as the rest of the commercial schema: the app reaches Postgres
-- through the service key and enforces access in code, so no permissive policy
-- is created here. An anon/authenticated client gets nothing.
