-- 167 · Which lines the customer actually took. (Stephanie, 2026-08)
--
-- HER NOTE: "once the job is won, are we able to click off on the items that
-- were approved and not approved in both inclusions and alternates, especially
-- if we are breaking out the price"
--
-- On a broken-out proposal a GC frequently awards PART of it — three of five
-- inclusions plus one alternate. Today the platform records only that the deal
-- was won, so what was actually bought lives in somebody's email.
--
-- NULLABLE ON PURPOSE, three states not two:
--   NULL  — nobody has said. The state every existing row is in, and the state
--           a proposal sits in until the GC answers.
--   TRUE  — the customer took this line.
--   FALSE — the customer explicitly did NOT take it.
--
-- A plain `boolean NOT NULL DEFAULT false` would record every line on every
-- proposal ever written as "customer declined it", which is a different and
-- much worse claim than "we never asked".
--
-- WHY IT IS NOT AN EDIT. The line-item write path refuses any change once a
-- proposal leaves draft (`assertProposalDraft`), and rightly so: the sent
-- document is the legal record. This column is not part of that document — it
-- is what the customer said about it afterwards — so it gets its own writer
-- that is deliberately exempt from that guard, and nothing else on the row may
-- move with it.

ALTER TABLE commercial_proposal_line_items
  ADD COLUMN IF NOT EXISTS customer_approved boolean;

COMMENT ON COLUMN commercial_proposal_line_items.customer_approved IS
  'Did the customer take this line? NULL = not answered (the default and the honest starting state), true = accepted, false = declined. Recorded AFTER the proposal is sent, so its writer is exempt from the draft-only guard. Never part of the sent document itself.';

-- Reading "what did they actually buy" is per-proposal, and only ever asks
-- about rows that have an answer.
CREATE INDEX IF NOT EXISTS commercial_proposal_line_items_approved_idx
  ON commercial_proposal_line_items (proposal_id)
  WHERE customer_approved IS NOT NULL;
