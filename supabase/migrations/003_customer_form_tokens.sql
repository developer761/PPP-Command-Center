-- 003_customer_form_tokens.sql
-- Phase 2 — Customer Color Form foundation.
--
-- Two tables:
--   customer_form_tokens — per-WO tokenized links sent to customers
--   sf_writes_audit      — append-only log of every Salesforce write the
--                          platform attempts, for replay + diagnostics
--
-- Run in Supabase SQL editor. Idempotent — safe to re-run.

-- ============================================================
-- customer_form_tokens
-- ============================================================
CREATE TABLE IF NOT EXISTS public.customer_form_tokens (
  token             TEXT PRIMARY KEY,
  work_order_id     TEXT NOT NULL,          -- SF WorkOrder.Id (15- or 18-char)
  work_order_number TEXT,                   -- Denormalized for display + audit
  customer_email    TEXT NOT NULL,
  customer_name     TEXT,                   -- Denormalized from Account.Name at send time
  account_id        TEXT,                   -- SF Account.Id
  -- Lifecycle timestamps
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  sent_at           TIMESTAMPTZ,            -- When Resend confirmed delivery
  delivery_status   TEXT,                   -- delivered / bounced / soft_bounced / spam
  opened_at         TIMESTAMPTZ,            -- First time customer hit /select/[token]
  submitted_at      TIMESTAMPTZ,            -- Customer hit submit
  submitted_payload JSONB,                  -- Full form payload
  -- Lock state — used during admin draft review so two admins don't stomp on each other
  draft_editing_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  draft_editing_until TIMESTAMPTZ,
  -- Vendor email lifecycle (one row per token, but multiple vendor emails possible
  -- for multi-supplier orders — see vendor_email_sends table below)
  vendor_email_sent_at TIMESTAMPTZ,         -- Last vendor email send timestamp (any)
  -- WOLI state at form-render time — used for conflict detection on submit
  woli_snapshot_at  TIMESTAMPTZ,            -- When we captured the WOLI shape
  -- Audit
  customer_ip       INET,                   -- IP that opened the form
  customer_user_agent TEXT
);

CREATE INDEX IF NOT EXISTS customer_form_tokens_wo_idx ON public.customer_form_tokens (work_order_id);
CREATE INDEX IF NOT EXISTS customer_form_tokens_expires_idx ON public.customer_form_tokens (expires_at) WHERE submitted_at IS NULL;
CREATE INDEX IF NOT EXISTS customer_form_tokens_submitted_idx ON public.customer_form_tokens (submitted_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS customer_form_tokens_open_idx ON public.customer_form_tokens (sent_at) WHERE submitted_at IS NULL AND expires_at > NOW();

ALTER TABLE public.customer_form_tokens ENABLE ROW LEVEL SECURITY;

-- Authenticated app uses service-role; no anon/auth role policies needed for the
-- main flow. /select/[token] route uses service-role server-side via the route
-- handler. RLS is defense-in-depth.
DROP POLICY IF EXISTS customer_form_tokens_admin_read ON public.customer_form_tokens;
CREATE POLICY customer_form_tokens_admin_read ON public.customer_form_tokens
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid() AND p.is_admin = TRUE
    )
  );

-- ============================================================
-- vendor_email_sends — one row per vendor email actually sent
-- ============================================================
-- A single form submission can fan out to multiple vendors (BM walls +
-- SW trim → 2 emails). Each send is one row here.
CREATE TABLE IF NOT EXISTS public.vendor_email_sends (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token           TEXT NOT NULL REFERENCES public.customer_form_tokens(token) ON DELETE CASCADE,
  work_order_id   TEXT NOT NULL,
  vendor_account_id TEXT,                   -- SF Account.Id of the vendor (BM, SW, etc.)
  vendor_name     TEXT NOT NULL,
  vendor_email    TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body_plain      TEXT NOT NULL,            -- Final body text the admin sent
  body_html       TEXT,                     -- Optional HTML version
  cc_addresses    TEXT[] DEFAULT ARRAY[]::TEXT[],
  bcc_addresses   TEXT[] DEFAULT ARRAY[]::TEXT[],
  -- Lifecycle
  drafted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  drafted_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  edited_at       TIMESTAMPTZ,              -- Last edit before send
  sent_at         TIMESTAMPTZ,              -- Resend confirmed accepted
  sent_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resend_message_id TEXT,                   -- Resend's message id for tracking
  delivery_status TEXT,                     -- delivered / bounced / opened / clicked
  delivery_status_updated_at TIMESTAMPTZ,
  -- For re-send / re-draft handling
  superseded_by   UUID REFERENCES public.vendor_email_sends(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS vendor_email_sends_token_idx ON public.vendor_email_sends (token);
CREATE INDEX IF NOT EXISTS vendor_email_sends_wo_idx ON public.vendor_email_sends (work_order_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS vendor_email_sends_resend_idx ON public.vendor_email_sends (resend_message_id) WHERE resend_message_id IS NOT NULL;

ALTER TABLE public.vendor_email_sends ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vendor_email_sends_admin_read ON public.vendor_email_sends;
CREATE POLICY vendor_email_sends_admin_read ON public.vendor_email_sends
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid() AND p.is_admin = TRUE
    )
  );

-- ============================================================
-- sf_writes_audit — every Salesforce write we attempt
-- ============================================================
-- Append-only log. Lets us replay history, debug "why did colors disappear",
-- detect double-writes, etc.
CREATE TABLE IF NOT EXISTS public.sf_writes_audit (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  triggered_by    TEXT NOT NULL,            -- 'customer_form_submit' / 'admin_manual' / 'system_resync' / etc.
  triggered_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  triggered_by_token TEXT REFERENCES public.customer_form_tokens(token) ON DELETE SET NULL,
  -- Target
  sf_object       TEXT NOT NULL,            -- 'WorkOrderLineItem', 'WorkOrder', etc.
  sf_record_id    TEXT NOT NULL,
  -- Payload
  field_writes    JSONB NOT NULL,           -- { ColorWall__c: '...', ColorCeiling__c: '...', ... }
  prior_values    JSONB,                    -- Optional snapshot of fields before the write
  -- Outcome
  succeeded       BOOLEAN NOT NULL,
  error_code      TEXT,                     -- SF error code if failed
  error_message   TEXT,
  retry_count     INT NOT NULL DEFAULT 0,
  duration_ms     INT
);

CREATE INDEX IF NOT EXISTS sf_writes_audit_record_idx ON public.sf_writes_audit (sf_record_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS sf_writes_audit_token_idx ON public.sf_writes_audit (triggered_by_token) WHERE triggered_by_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS sf_writes_audit_failed_idx ON public.sf_writes_audit (attempted_at DESC) WHERE succeeded = FALSE;

ALTER TABLE public.sf_writes_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sf_writes_audit_admin_read ON public.sf_writes_audit;
CREATE POLICY sf_writes_audit_admin_read ON public.sf_writes_audit
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid() AND p.is_admin = TRUE
    )
  );

-- ============================================================
-- updated_at-style auto-touch where useful
-- ============================================================
CREATE OR REPLACE FUNCTION public.touch_vendor_email_sends_edited_at()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.body_plain IS DISTINCT FROM OLD.body_plain
     OR NEW.subject IS DISTINCT FROM OLD.subject THEN
    NEW.edited_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vendor_email_sends_touch_edited_at ON public.vendor_email_sends;
CREATE TRIGGER vendor_email_sends_touch_edited_at
  BEFORE UPDATE ON public.vendor_email_sends
  FOR EACH ROW
  WHEN (OLD.sent_at IS NULL)  -- Only count edits before send
  EXECUTE FUNCTION public.touch_vendor_email_sends_edited_at();

-- Done.
