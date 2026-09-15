-- The workspace's reply-to address, held to one bare address.
--
-- Karan, 2026-09-15: reply_to_email is the last messaging column nothing could
-- set. It now has a field on the settings page, and it goes into the Reply-To
-- header of every campaign email for that workspace — NOT the From header,
-- which stays the shared verified sender (see lib/messaging/reply-to.ts).
--
-- WHY A CONSTRAINT. The value becomes a mail header. A line break in it is
-- header injection ("a@b.com\r\nBcc: …"), and a comma turns one reply-to into
-- several. The settings page refuses both, and the send path drops a bad value
-- again, but a row edited in the dashboard or imported from Hatch passes
-- through neither. The database is the one place every write goes.
--
-- Same shape as validateReplyTo, checked against each other by
-- scripts/verify-reply-to-e2e.mjs. Every workspace is NULL today (verified
-- 2026-09-15: 0 of 32 rows set), so nothing existing is refused.
--
-- Safe to re-run.

ALTER TABLE public.sms_sub_accounts DROP CONSTRAINT IF EXISTS sms_sub_accounts_reply_to_email_chk;
ALTER TABLE public.sms_sub_accounts
  ADD CONSTRAINT sms_sub_accounts_reply_to_email_chk CHECK (
    reply_to_email IS NULL
    OR (
      length(reply_to_email) <= 254
      -- No whitespace or control characters anywhere. [[:cntrl:]] covers
      -- CR and LF; [[:space:]] covers the rest.
      AND reply_to_email !~ '[[:cntrl:][:space:]]'
      AND reply_to_email ~ '^[^@,;<>"()\[\]\\]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$'
    )
  );

COMMENT ON COLUMN public.sms_sub_accounts.reply_to_email IS
  'Reply-To for this workspace''s campaign emails: the inbox a customer''s reply lands in. Never the From address, which is the shared verified sender. One bare address; NULL means replies go to the shared sender.';
