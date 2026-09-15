-- Commercial proposal e-signature (Karan 2026-09-15).
--
-- "The customer also has to do the signature ... and we need [the S-Docs audit
-- trail] for every time a customer signs, under Reports, saved as a PDF."
--
-- Flow: the proposal is emailed with a "Review & sign" link → the GC signs on a
-- public page (signer 1/2) → Brendan countersigns in-app with the stored
-- signature (signer 2/2) → a signed PDF and an audit-trail certificate are
-- filed against the deal.
--
-- Two tables:
--   commercial_signature_requests — one per link sent. A proposal re-sent to a
--     second address gets a second request; the first one to be signed wins
--     and the rest are voided.
--   commercial_signature_events — the audit trail. Append-only: rows can't be
--     updated or deleted. The certificate is rendered from these rows, so a row
--     that could be edited or removed later would make it worthless. Deleting a
--     proposal or deal that carries a trail is refused for the same reason (the
--     cascade reaches the guard). A deliberate wipe opts in for its own
--     transaction with: set local commercial.allow_signature_event_delete = 'on';
--
-- Both are service-role only (RLS on, no policies): they hold signer IP
-- addresses and link-token hashes, and every read goes through the server.

create table if not exists public.commercial_signature_requests (
  id                        uuid primary key default gen_random_uuid(),
  proposal_id               uuid not null references public.commercial_proposals(id) on delete cascade,
  opportunity_id            uuid not null references public.commercial_opportunities(id) on delete cascade,
  revision_number           integer not null,

  -- sha256 (hex) of the link token. The token itself is never stored: a leaked
  -- database backup must not be a folder of working signing links.
  token_hash                text not null unique,

  status                    text not null default 'awaiting_customer',
  expires_at                timestamptz not null,

  signer_email              text not null,
  signer_name               text,

  -- The exact bytes the GC was asked to sign: the proposal snapshot document
  -- and its sha256 at the moment the link was issued. Signing re-hashes the
  -- stored file and refuses if it no longer matches.
  document_id               uuid references public.commercial_documents(id) on delete set null,
  document_sha256           text not null,

  requested_by_user_id      uuid references auth.users(id) on delete set null,
  requested_by_name         text,
  requested_by_email        text,

  -- Signer 1/2 — the customer.
  customer_name             text,
  customer_title            text,
  customer_company          text,
  customer_signature_method text,
  customer_signature_key    text,
  -- sha256 of the signature PNG as submitted. Countersigning re-hashes the
  -- stored image and refuses if it changed, the same promise the proposal
  -- document gets.
  customer_signature_sha256 text,
  customer_signed_at        timestamptz,
  customer_ip               text,
  customer_user_agent       text,

  declined_at               timestamptz,
  decline_reason            text,

  -- Signer 2/2 — Tomco.
  countersigned_by_user_id  uuid references auth.users(id) on delete set null,
  countersigner_name        text,
  countersigner_title       text,
  countersigner_email       text,
  countersigned_at          timestamptz,
  countersigner_ip          text,
  countersigner_user_agent  text,

  -- Filed outputs. signed_sha256 is the hash of the signed document file
  -- (proposal + signature page) and is printed on the certificate.
  signed_document_id        uuid references public.commercial_documents(id) on delete set null,
  signed_sha256             text,
  audit_document_id         uuid references public.commercial_documents(id) on delete set null,

  voided_at                 timestamptz,
  void_reason               text,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint commercial_signature_requests_status_check check (status in (
    'awaiting_customer', 'awaiting_countersign', 'completed', 'declined', 'voided', 'expired'
  )),
  constraint commercial_signature_requests_method_check check (
    customer_signature_method is null or customer_signature_method in ('typed', 'drawn')
  )
);

create index if not exists commercial_signature_requests_proposal_idx
  on public.commercial_signature_requests (proposal_id, created_at desc);
create index if not exists commercial_signature_requests_opportunity_idx
  on public.commercial_signature_requests (opportunity_id);
create index if not exists commercial_signature_requests_status_idx
  on public.commercial_signature_requests (status, created_at desc);

-- One signature per proposal. Two links for the same proposal can be open at
-- once (re-send, a colleague on CC); if both are signed in the same second the
-- second one hits this index instead of producing two contracts.
create unique index if not exists commercial_signature_requests_one_signed_per_proposal
  on public.commercial_signature_requests (proposal_id)
  where status in ('awaiting_countersign', 'completed');

create or replace function public.set_updated_at_commercial_signature_requests()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists commercial_signature_requests_updated_at on public.commercial_signature_requests;
create trigger commercial_signature_requests_updated_at
  before update on public.commercial_signature_requests
  for each row execute function public.set_updated_at_commercial_signature_requests();

create table if not exists public.commercial_signature_events (
  id           bigint generated always as identity primary key,
  request_id   uuid not null references public.commercial_signature_requests(id) on delete cascade,
  at           timestamptz not null default now(),
  type         text not null,
  actor_name   text,
  actor_email  text,
  ip           text,
  user_agent   text,
  details      text not null default '',

  constraint commercial_signature_events_type_check check (type in (
    'CREATE', 'EMAIL', 'VIEW', 'CONSENT', 'SUBMIT', 'DECLINE',
    'COUNTERSIGN', 'COMPLETE', 'VOID', 'EXPIRE'
  ))
);

create index if not exists commercial_signature_events_request_idx
  on public.commercial_signature_events (request_id, at, id);

create or replace function public.commercial_signature_events_append_only()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('commercial.allow_signature_event_delete', true) = 'on' then
    return old;
  end if;
  raise exception 'commercial_signature_events is append-only (% refused)', tg_op;
end;
$$;

drop trigger if exists commercial_signature_events_no_update on public.commercial_signature_events;
create trigger commercial_signature_events_no_update
  before update or delete on public.commercial_signature_events
  for each row execute function public.commercial_signature_events_append_only();

alter table public.commercial_signature_requests enable row level security;
alter table public.commercial_signature_events enable row level security;
