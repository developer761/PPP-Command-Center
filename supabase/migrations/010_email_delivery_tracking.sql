-- ============================================================
-- 010 — Email delivery tracking
--
-- Adds delivery-status columns so the Mail Hub's Sent view can show
-- "Delivered to BM at 2:14pm" vs "⚠ Bounced — re-send" vs "Customer
-- opened the email" instead of just "sent". Powered by a new Resend
-- events webhook (/api/webhooks/resend-events) that subscribes to
-- email.delivered / email.bounced / email.complaint / email.opened /
-- email.clicked and updates the originating row by resend_message_id.
--
-- IF-NOT-EXISTS safe for re-run.
-- ============================================================

-- customer_form_tokens: add the message id we need to thread events back
-- + delivery_status_updated_at so we know when the last status change was.
ALTER TABLE public.customer_form_tokens
  ADD COLUMN IF NOT EXISTS resend_message_id_invite TEXT;
ALTER TABLE public.customer_form_tokens
  ADD COLUMN IF NOT EXISTS delivery_status_updated_at TIMESTAMPTZ;

-- Unique-ish index for the webhook lookup (NULL-safe partial)
CREATE INDEX IF NOT EXISTS customer_form_tokens_resend_idx
  ON public.customer_form_tokens (resend_message_id_invite)
  WHERE resend_message_id_invite IS NOT NULL;

-- supplier_orders: same shape
ALTER TABLE public.supplier_orders
  ADD COLUMN IF NOT EXISTS delivery_status TEXT;
ALTER TABLE public.supplier_orders
  ADD COLUMN IF NOT EXISTS delivery_status_updated_at TIMESTAMPTZ;

-- supplier_orders.resend_message_id already exists from migration 005.
-- Just need the index for the events lookup.
CREATE INDEX IF NOT EXISTS supplier_orders_resend_idx
  ON public.supplier_orders (resend_message_id)
  WHERE resend_message_id IS NOT NULL;
