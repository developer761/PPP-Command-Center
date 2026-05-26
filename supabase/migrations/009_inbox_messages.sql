-- Phase 2 — Command Center inbox
-- ------------------------------------------------------------------
-- Inbound emails sent to orders@orders.precisionpaintingplus.net land here
-- via Resend's inbound webhook. Threaded by Resend message-id (most
-- reliable) with PO-number and customer-email fallback matchers.
--
-- Per Karan's directive: ALL supplier replies + customer follow-ups must
-- flow into the Command Center inbox, not Gmail. This table is the
-- foundation.
--
-- `kind` enum:
--   - customer_reply  — reply from a customer-form recipient (matched to
--                        a customer_form_tokens row)
--   - supplier_reply  — reply from a supplier order recipient (matched to
--                        a supplier_orders row)
--   - unmatched       — couldn't thread to anything; goes to a triage
--                        bucket so admin can investigate
--
-- Safe to re-run via IF NOT EXISTS guards.

CREATE TABLE IF NOT EXISTS inbox_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('customer_reply', 'supplier_reply', 'unmatched')),
  -- Threading anchors — set by the webhook on best-effort basis
  linked_token TEXT,                -- customer_form_tokens.token (when matched)
  linked_order_id UUID,             -- supplier_orders.id (when matched)
  linked_work_order_id TEXT,        -- denormalized for fast WO-scoped filtering
  -- Email contents
  from_email TEXT NOT NULL,
  from_name TEXT,
  to_email TEXT,                    -- what address Resend received it at
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  -- Resend metadata for threading
  resend_message_id TEXT UNIQUE,    -- unique to prevent duplicate ingestion on webhook retries
  in_reply_to TEXT,                 -- In-Reply-To header from the inbound email
  -- Lifecycle
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_by_user_id UUID,
  read_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  -- Raw webhook payload for debug / replay
  raw_payload JSONB
);

-- Unread inbox list — primary query path. Partial index keeps it small.
CREATE INDEX IF NOT EXISTS inbox_messages_unread_idx
  ON inbox_messages (received_at DESC)
  WHERE read_at IS NULL AND archived_at IS NULL;

-- Per-WO filter — when admin clicks "View messages for this WO"
CREATE INDEX IF NOT EXISTS inbox_messages_wo_idx
  ON inbox_messages (linked_work_order_id, received_at DESC)
  WHERE linked_work_order_id IS NOT NULL;

-- Kind-scoped listing (Customer / Supplier / Unmatched tabs)
CREATE INDEX IF NOT EXISTS inbox_messages_kind_idx
  ON inbox_messages (kind, received_at DESC)
  WHERE archived_at IS NULL;

COMMENT ON TABLE inbox_messages IS
  'Phase 2 Command Center inbox. Inbound Resend emails to orders@orders.precisionpaintingplus.net land here via the inbound webhook. Threaded by message-id, PO number, or sender match.';
