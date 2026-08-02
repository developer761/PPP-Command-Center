-- RUX-6: proposal "receivers" — people who get pinged when a proposal is
-- approved or sent back with changes (a distribution list for proposal
-- decisions, independent of who approves). Mirrors approver_emails (mig 104/105).
ALTER TABLE commercial_operating_company
  ADD COLUMN IF NOT EXISTS receiver_emails text[] NOT NULL DEFAULT '{}';

-- Atomic add/remove of a receiver email on the singleton operating company —
-- same shape as commercial_set_proposal_approver so two admins toggling at once
-- can't drop each other's change. Idempotent (CREATE OR REPLACE).
create or replace function commercial_set_proposal_receiver(p_email text, p_make boolean)
returns text[]
language plpgsql
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_result text[];
begin
  if v_email = '' then
    raise exception 'receiver email is required';
  end if;
  update commercial_operating_company
  set receiver_emails = case
        when p_make then
          case when v_email = any(receiver_emails)
               then receiver_emails
               else array_append(receiver_emails, v_email) end
        else array_remove(receiver_emails, v_email)
      end,
      updated_at = now()
  where id = true
  returning receiver_emails into v_result;
  return coalesce(v_result, array[]::text[]);
end;
$$;
