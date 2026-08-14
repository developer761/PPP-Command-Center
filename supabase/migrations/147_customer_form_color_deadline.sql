-- 147 — the sender sets the colour deadline.
--
-- Kate round-3 #07: "That last fallback is always in the past, so customers are
-- regularly shown a deadline that has already expired."
--
-- The form told the customer they could update colours until a date derived
-- from Start Date → Desired Start Date → the Opportunity's Close Date. The
-- Close Date is a projection PPP sets when the deal is quoted, so by the time a
-- colour form goes out it is routinely in the past — and the customer was
-- told their window had already closed.
--
-- The measurement Kate sent makes the case: on work orders sitting in
-- Coordination or Scheduling — the point the form actually goes out — 68% have
-- no start date to default from. So there is nothing to derive it from, and it
-- has to be a decision the sender makes.
--
-- Per token, not per work order: re-sending a form is a new conversation with a
-- new deadline, and the old token's promise shouldn't silently change.

alter table public.customer_form_tokens
  add column if not exists color_deadline date;

comment on column public.customer_form_tokens.color_deadline is
  'Date the sender told the customer their colours are needed by. Set on the send form; defaults to the work order Start Date when there is one, otherwise blank. Never rendered when in the past. Kate round-3 #07.';
