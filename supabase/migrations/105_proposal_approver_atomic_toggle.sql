-- R1d follow-up: atomic add/remove of a proposal-approver email on the singleton
-- operating company. Replaces the route's read-modify-write (which could drop a
-- concurrent toggle) with a single UPDATE that mutates the array in place.
-- Idempotent: re-running CREATE OR REPLACE is safe.
create or replace function commercial_set_proposal_approver(p_email text, p_make boolean)
returns text[]
language plpgsql
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_result text[];
begin
  if v_email = '' then
    raise exception 'approver email is required';
  end if;
  update commercial_operating_company
  set approver_emails = case
        when p_make then
          case when v_email = any(approver_emails)
               then approver_emails
               else array_append(approver_emails, v_email) end
        else array_remove(approver_emails, v_email)
      end,
      updated_at = now()
  where id = true
  returning approver_emails into v_result;
  return coalesce(v_result, array[]::text[]);
end;
$$;
