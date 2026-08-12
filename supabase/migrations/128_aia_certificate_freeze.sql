-- 128: freeze a G702 certificate when it is issued.
--
-- An AIA payment application is a signed, notarised document sent to the GC.
-- Once issued it must never change. Today it does.
--
-- The G703 schedule of values is written once, at seed, and frozen. But G702
-- lines 1 and 2 are recomputed on EVERY READ — line 1 from the live contract
-- ladder, line 2 from the live approved-change-order sum. So approving a change
-- order after the seed moves line 3 (= 1 + 2) while the frozen G703 total stays
-- where it was. Two things break at once:
--
--   * the AIA footing invariant, line 3 = the G703 grand total, fails, and the
--     exported certificate visibly does not add up; and
--   * an application already submitted or paid silently restates its contract
--     sum, its percent complete and its balance to finish — a document the GC
--     is holding a printed copy of.
--
-- The original design DID freeze this: `original_contract_cents` on this table
-- carries the comment "snapshotted at creation so a later contract edit doesn't
-- silently restate a submitted certificate." A later fix — making every surface
-- agree about a deal's contract value — put the shared proposal ladder above
-- that column, which un-froze the certificates as a side effect. This restores
-- the freeze without giving up the agreement: drafts still track live, issued
-- certificates hold.
--
-- Deliberately NOT backfilled here. Recovering what an already-issued
-- certificate SHOULD say is a separate reviewed step — the correct value is
-- whatever was on the PDF that went to the GC, and this database does not hold
-- that. Until then, the code freezes on submit going forward and existing
-- issued applications keep their current live behaviour rather than being
-- rewritten to a number nobody has verified.
--
-- Safe to re-run.

-- G702 line 1, "ORIGINAL CONTRACT SUM", as it stood when the certificate was
-- issued. Distinct from `original_contract_cents`, which is the operator's
-- editable input at creation; this is the resolved figure actually printed.
ALTER TABLE public.commercial_aia_applications
  ADD COLUMN IF NOT EXISTS contract_sum_frozen_cents BIGINT;

-- G702 line 2, "NET CHANGE BY CHANGE ORDERS", likewise frozen at issue.
ALTER TABLE public.commercial_aia_applications
  ADD COLUMN IF NOT EXISTS net_change_orders_frozen_cents BIGINT;

-- When the freeze was taken. Also the marker for "this certificate is frozen" —
-- a NULL here on a non-draft application means it predates this migration and
-- is still computing live, which the code reports rather than hides.
ALTER TABLE public.commercial_aia_applications
  ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ;

-- ── Change-order rows on the schedule of values ────────────────────────────
--
-- The seed appends one G703 row per approved change order. It matched them by
-- `item_no` ('CO-001'), which is a user-editable text field — rename it and the
-- next sync re-inserts the row, double-counting a change order on a live
-- certificate. Match on the actual foreign key instead.
ALTER TABLE public.commercial_aia_line_items
  ADD COLUMN IF NOT EXISTS change_order_id UUID
  REFERENCES public.commercial_change_orders(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS commercial_aia_line_items_co_idx
  ON public.commercial_aia_line_items (application_id, change_order_id)
  WHERE change_order_id IS NOT NULL;

-- ── Deductive change orders ────────────────────────────────────────────────
--
-- `commercial_change_orders.amount_cents` is SIGNED — negative means a deduct or
-- credit, and the schema says so. But the schedule-of-values column refused
-- anything below zero, and the seed inserts every CO row in one batch. So a
-- single credit CO failed the CHECK, took the whole insert down with it, and the
-- failure was swallowed by a best-effort try/catch: the operator got an
-- application with a completely blank G703 and no error at all.
--
-- A descoped line is a real thing on a real certificate. The column has to be
-- able to hold one.
ALTER TABLE public.commercial_aia_line_items
  DROP CONSTRAINT IF EXISTS commercial_aia_line_items_scheduled_value_cents_check;
