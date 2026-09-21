-- What AWS is told to send FROM, when that is not just the number.
--
-- Karan, 2026-09-21: the numbers are already inside AWS, in the account that
-- hosts them today rather than PPP's own. AWS End User Messaging does not
-- accept ported numbers from outside AWS at all, so the path is not a port:
-- the owning account shares each number with PPP's account (AWS RAM), or
-- ownership is moved between accounts.
--
-- A SHARED NUMBER IS ADDRESSED BY ARN. From the AWS docs: shared resources
-- "can only be used with the AWS End User Messaging SMS API" and "You must use
-- the full Amazon Resource Name (ARN) of the shared resource". SendTextMessage
-- is already what this system calls, so the only thing missing is somewhere to
-- put the ARN.
--
--   arn:aws:sms-voice:us-east-1:111122223333:phone-number/phone-abc123
--
-- NULL means send from phone_e164, which is what an owned number does and what
-- every workspace does today. Nothing changes until an ARN is set.
--
-- Safe to re-run.

ALTER TABLE public.sms_sub_accounts
  ADD COLUMN IF NOT EXISTS origination_identity TEXT;

ALTER TABLE public.sms_sub_accounts DROP CONSTRAINT IF EXISTS sms_sub_accounts_origination_identity_chk;
ALTER TABLE public.sms_sub_accounts
  ADD CONSTRAINT sms_sub_accounts_origination_identity_chk CHECK (
    origination_identity IS NULL
    -- An ARN for a phone number, or a phone-number id. Anything else is a
    -- typo that would fail at the carrier, one message at a time.
    OR origination_identity ~ '^arn:aws[a-z-]*:sms-voice:[a-z0-9-]+:[0-9]{12}:phone-number/.+$'
    OR origination_identity ~ '^phone-[A-Za-z0-9]+$'
  );

COMMENT ON COLUMN public.sms_sub_accounts.origination_identity IS
  'What AWS is told to send FROM: the full ARN of a phone number shared from another AWS account, or a phone-number id. NULL means use phone_e164, which is right for a number this account owns. Migration 20260921132428.';
