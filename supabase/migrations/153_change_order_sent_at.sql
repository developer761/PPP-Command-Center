-- 153 · Record when a change order went to the GC. (Stephanie, 2026-08-18)
--
-- She described the workflow the platform was missing the middle of:
-- "A change order ... requires us to first submit it in writing in proposal
-- format and then an approval from the customer."
--
-- The document existed and the pending → approved / declined statuses existed,
-- but there was no way to SEND it, so that step happened in someone's mail
-- client and left no trace on the job. Emailing it now works
-- (lib/commercial/change-orders/email.ts); this is where "we sent it" lives.
--
-- Deliberately a timestamp and NOT a status. `pending` has to keep meaning
-- "awaiting the customer's answer" — if sending flipped a status, an unanswered
-- change order would start counting toward the contract, which is the one thing
-- a change order must never do before it is approved. Sent and answered are two
-- different facts, so they get two different columns.
--
-- Null on every existing row, which is correct: nothing has been sent from the
-- platform yet.

alter table commercial_change_orders
  add column if not exists sent_at timestamptz;

comment on column commercial_change_orders.sent_at is
  'When the CO document was emailed to the GC for written approval. NOT a status — approval is still recorded separately via status, so an unanswered CO never counts toward the contract.';

-- Finding the ones that are out and unanswered is the query Katie and Stephanie
-- will actually run ("what am I chasing?"), so index for it.
create index if not exists commercial_change_orders_sent_pending_idx
  on commercial_change_orders (opportunity_id, sent_at)
  where deleted_at is null and status = 'pending';
