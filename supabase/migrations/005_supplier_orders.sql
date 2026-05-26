-- Phase 2 — Supplier Orders
-- ------------------------------------------------------------------
-- One row per outbound supplier order. Drafts persist before send so an
-- admin can come back to a half-built order; the send action flips
-- status='sent' and stamps sent_at/resend_message_id.
--
-- IDEMPOTENCY: the UNIQUE constraint on (work_order_id, supplier_account_id,
-- status) WHEN status='draft' prevents two parallel drafts for the same
-- WO+supplier (DEFERRABLE so admins can transition draft→sent in a single
-- transaction without violating). When admin re-orders the same WO+supplier
-- after a previous send, status='sent' rows don't collide because the
-- partial-unique semantics only catch open drafts.
--
-- PO_NUMBER: auto-generated via the dedicated sequence (supplier_orders_po_seq)
-- so racing inserts always get distinct numbers. Format applied at insert
-- time by the code in lib/supplier-order/builder.ts. Sequence is unbounded
-- so no manual reset needed.
--
-- Safe to re-run via IF NOT EXISTS guards.

CREATE SEQUENCE IF NOT EXISTS supplier_orders_po_seq;

CREATE TABLE IF NOT EXISTS supplier_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id TEXT NOT NULL,
  work_order_number TEXT,
  supplier_account_id TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  -- Format: PPP-WO{wo_number}-{supplier_code}-{seq}
  -- e.g.    PPP-WO00012345-BM-000124
  po_number TEXT NOT NULL UNIQUE,
  -- Draft body — admin's final edited email text. Source-of-truth for what
  -- went out (or will go out). Kept separately from the builder's output so
  -- admin edits aren't overwritten if the builder is re-run.
  draft_body TEXT,
  special_instructions TEXT,
  -- Fulfillment
  fulfillment_method TEXT NOT NULL DEFAULT 'delivery'
    CHECK (fulfillment_method IN ('delivery', 'pickup')),
  -- JSON shape: { name, street, city, state, postalCode, country?, source }
  -- where source ∈ ('customer_form', 'sf_account', 'manual', 'pickup'(null))
  delivery_address JSONB,
  pickup_location TEXT,       -- supplier store ref (e.g. "BM Smithtown")
  required_by_date DATE,
  -- Line items — normalized snapshot at draft-create time
  -- Shape: [{ surface, colorId, colorName, colorCode, finish, sqft, gallons, sourceWoliId }]
  line_items JSONB NOT NULL,
  -- Extras — worker-added items from the supplier_extras catalog
  -- Shape: [{ extraId, name, unit, qty }]
  extras JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'acknowledged', 'delivered', 'cancelled', 'failed')),
  sent_at TIMESTAMPTZ,
  sent_to_email TEXT,
  resend_message_id TEXT,
  acknowledged_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  failure_reason TEXT,
  -- Audit
  created_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial unique index: only ONE open draft per (wo, supplier). Once
-- status moves past 'draft', the constraint no longer applies so re-orders
-- on a previously-sent line work cleanly.
CREATE UNIQUE INDEX IF NOT EXISTS supplier_orders_one_open_draft_idx
  ON supplier_orders (work_order_id, supplier_account_id)
  WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS supplier_orders_wo_idx
  ON supplier_orders (work_order_id);

CREATE INDEX IF NOT EXISTS supplier_orders_status_updated_idx
  ON supplier_orders (status, updated_at DESC);

-- updated_at touch trigger
CREATE OR REPLACE FUNCTION supplier_orders_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS supplier_orders_touch_trigger ON supplier_orders;
CREATE TRIGGER supplier_orders_touch_trigger
  BEFORE UPDATE ON supplier_orders
  FOR EACH ROW
  EXECUTE FUNCTION supplier_orders_touch_updated_at();

-- RPC wrapper so the application can call nextval() over PostgREST without
-- needing direct sequence access. Returns the next bigint from the sequence.
CREATE OR REPLACE FUNCTION nextval_supplier_orders_po_seq()
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN nextval('supplier_orders_po_seq');
END;
$$;

COMMENT ON TABLE supplier_orders IS
  'Phase 2 supplier orders. One row per outbound order. Drafts persist before send. PO number auto-generated via supplier_orders_po_seq.';
