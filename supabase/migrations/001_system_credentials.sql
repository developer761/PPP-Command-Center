-- system_credentials — server-only secrets table for storing third-party API
-- credentials (Salesforce refresh token, etc.) that need to be persistent and
-- rotatable but must never be exposed to the browser.
--
-- Access pattern:
--   - Service role key (server-side only) reads + writes.
--   - Anon/authenticated users CANNOT read or write — enforced via RLS.
--
-- Why a table instead of env vars?
--   - Easy rotation without redeploys
--   - Easy revocation (delete the row)
--   - Single source of truth across local dev + Vercel preview + production
--   - Audit trail via updated_at

create table if not exists public.system_credentials (
  key text primary key,
  value text not null,
  metadata jsonb default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

comment on table public.system_credentials is
  'Server-only secrets. RLS locks down all client access; only service role can read/write.';

-- Track changes
create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_touch_system_credentials on public.system_credentials;
create trigger trg_touch_system_credentials
  before update on public.system_credentials
  for each row execute procedure public.touch_updated_at();

-- Lock it down. RLS denies everything by default; we never write a policy
-- granting anon or authenticated access. Service role bypasses RLS automatically.
alter table public.system_credentials enable row level security;

-- Explicitly revoke anything that might have been granted by default
revoke all on public.system_credentials from anon;
revoke all on public.system_credentials from authenticated;
