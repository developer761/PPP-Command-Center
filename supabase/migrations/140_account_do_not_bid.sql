-- 140 — "do not bid" on an account.
--
-- Stephanie 2026-08-13: "Accounts > Rating system? Can we personalize these or
-- add something that says 'do not bid'."
--
-- Deliberately NOT a fourth rating letter. A/B/C grades how good a customer is
-- and lives behind a CHECK constraint (migration 020); "do not bid" is a
-- different kind of statement — a decision, with a reason and a date and a
-- person behind it. Squeezing it into the grade would lose all three, and
-- would mean a D-rated account is indistinguishable from one somebody
-- deliberately blacklisted after a bad job.
--
-- It WARNS, it does not block (Karan's standing rule). Someone will eventually
-- have a good reason to bid a do-not-bid GC — a new PM, a settled dispute —
-- and a hard stop just means the deal gets created under a different account
-- and the history is lost.
--
-- The reason is the point. "Do not bid" with no reason becomes folklore
-- nobody can overturn once the person who set it leaves.

alter table commercial_accounts
  add column if not exists do_not_bid boolean not null default false,
  add column if not exists do_not_bid_reason text,
  add column if not exists do_not_bid_set_at timestamptz,
  add column if not exists do_not_bid_set_by_user_id uuid;

comment on column commercial_accounts.do_not_bid is
  'Flagged do-not-bid. Warns on new work, never blocks it — see Karan''s warn-don''t-reject rule.';
comment on column commercial_accounts.do_not_bid_reason is
  'Why. Required in the UI when setting the flag: an unexplained do-not-bid becomes folklore nobody can overturn.';

-- Partial index: the flagged accounts are the rare ones, and they are what the
-- list filter and the header badge look up.
create index if not exists commercial_accounts_do_not_bid_idx
  on commercial_accounts (do_not_bid)
  where do_not_bid;
