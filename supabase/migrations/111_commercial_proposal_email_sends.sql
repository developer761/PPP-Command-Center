-- 111 · Kim — send proposals to the GC via Resend.
--
-- Each row is one outbound delivery of a proposal PDF to a general contractor.
-- A proposal can be emailed more than once (re-send), so this is a log, not a
-- 1:1. `resend_message_id` lets the existing resend-events webhook stamp
-- delivered/bounced later, and lets a GC reply thread back into the archive.

create table if not exists public.commercial_proposal_email_sends (
  id                uuid primary key default gen_random_uuid(),
  proposal_id       uuid not null references public.commercial_proposals(id) on delete cascade,
  opportunity_id    uuid,
  account_id        uuid,
  revision_number   integer,
  to_email          text not null,
  cc_email          text,
  subject           text,
  resend_message_id text,
  -- delivery lifecycle for a future resend-events update: sent → delivered / bounced
  status            text not null default 'sent',
  sent_by_user_id   uuid,
  created_at        timestamptz not null default now()
);

create index if not exists commercial_proposal_email_sends_proposal_idx
  on public.commercial_proposal_email_sends (proposal_id, created_at desc);
create index if not exists commercial_proposal_email_sends_account_idx
  on public.commercial_proposal_email_sends (account_id);
create index if not exists commercial_proposal_email_sends_resend_idx
  on public.commercial_proposal_email_sends (resend_message_id);
