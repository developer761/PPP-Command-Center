-- Migration 106: crew Work Orders (R2, post-contract).
--
-- A Work Order is the crew's marching-orders sheet for a won job: the scope
-- (Inclusions / Alternates / Exclusions) pulled from the accepted proposal, plus
-- the Room Finish Schedule pulled from commercial_opp_finishes — Tomco's real
-- "work order" IS essentially a room-finish schedule. The body is composed LIVE
-- from those sources while the WO is a draft; on "send to crew" the current PDF
-- is frozen into Documents (category 'work_order'), mirroring Closeout.
--
-- One Work Order row per opportunity (revisable via status/void, like closeout).
-- Status queue for the cross-account index derives: no row = "not created",
-- status='draft' = "draft", status='sent' = "sent to crew".
--
-- Service-role-only RLS (all commercial data is reached through the service-role
-- client behind assertCommercialAccess). Idempotent: IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS public.commercial_work_orders (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id            UUID NOT NULL REFERENCES public.commercial_opportunities(id) ON DELETE CASCADE,
  account_id                UUID NOT NULL REFERENCES public.commercial_accounts(id) ON DELETE CASCADE,

  status                    TEXT NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft','sent','voided')),

  -- Crew-facing free-text instructions that print under the scope (site access,
  -- staging, sequence notes, safety, etc.). Optional.
  work_notes                TEXT,
  -- Optional crew / foreman the WO is addressed to, and a target start date.
  assigned_to               TEXT,
  scheduled_start_date      DATE,

  -- Lifecycle + the frozen sent PDF.
  sent_at                   TIMESTAMPTZ,
  voided_at                 TIMESTAMPTZ,
  snapshot_document_id      UUID,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id        UUID,
  updated_by_user_id        UUID
);

-- One live (non-voided) work order per opportunity.
CREATE UNIQUE INDEX IF NOT EXISTS commercial_work_orders_one_live_per_opp
  ON public.commercial_work_orders (opportunity_id)
  WHERE voided_at IS NULL;

CREATE INDEX IF NOT EXISTS commercial_work_orders_account_idx
  ON public.commercial_work_orders (account_id);

ALTER TABLE public.commercial_work_orders ENABLE ROW LEVEL SECURITY;
