-- Migration 036 — Stage 2: BCC Archive for Commercial CC
--
-- Lets Alex (and any PM) BCC a unique address on outbound customer / GC /
-- architect emails. Resend inbound webhook recognizes the address, verifies
-- a short HMAC, and stores the email against the matching opportunity OR
-- account. New "Email Archive" tab on the opp / account detail page shows
-- the conversation so the whole team has context without digging through
-- Gmail.
--
-- Address scheme (built in code):
--   <local>+archive-<kind>-<shortId>-<hmac6>@<archive_domain>
-- where <kind> = "opp" | "acc", <shortId> = first 8 chars of the source
-- UUID, <hmac6> = first 6 chars of HMAC-SHA256(kind|shortId, secret).
--
-- Without the HMAC anyone who guessed an opp ID could inject fake "internal"
-- emails. Mismatch → silently drop in the webhook (don't bounce — Resend
-- would retry).
--
-- Paste-in-Supabase safe: every CREATE is IF NOT EXISTS.

-- ════════════════════════════════════════════════════════════════════════
-- 1. commercial_archived_emails — one row per (source_record, message_id)
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.commercial_archived_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which record this email is archived against.
  source_kind TEXT NOT NULL CHECK (source_kind IN ('opp', 'acc')),
  -- Soft FK — we don't enforce against commercial_opportunities/accounts
  -- because the row may be archived BEFORE the parent record is created
  -- (rare race) and because a soft-deleted parent shouldn't cascade-delete
  -- historical email evidence. UI filters out emails whose parent is
  -- deleted_at NOT NULL.
  source_id UUID NOT NULL,

  -- Envelope
  message_id TEXT NOT NULL,        -- RFC822 Message-ID (dedup key)
  in_reply_to TEXT,                -- threading parent (set if reply)

  from_email TEXT NOT NULL,
  from_name TEXT,
  to_emails TEXT[] NOT NULL DEFAULT '{}',
  cc_emails TEXT[] NOT NULL DEFAULT '{}',
  bcc_emails TEXT[] NOT NULL DEFAULT '{}',

  subject TEXT,
  -- body_text capped client-side at 200KB. body_html holds the SANITIZED
  -- version (strip script/style/iframe/on-* handlers/javascript:). UI
  -- renders body_text by default; "Show HTML" toggle uses body_html.
  body_text TEXT,
  body_html TEXT,
  body_truncated BOOLEAN NOT NULL DEFAULT FALSE,

  -- attachments stored in commercial-email-attachments bucket; the JSONB
  -- captures filename + size + mime + storage_key for each file. Download
  -- via signed URL through a dedicated download route (TBD).
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Classification — drives row tone in the UI.
  -- "external" = sender domain is NOT precisionpaintingplus.{com,net}
  -- "system"   = bounce / auto-reply / vacation responder (detected via
  --              Auto-Submitted / Precedence headers + subject heuristics)
  -- "internal" = sender on PPP domain
  classification TEXT NOT NULL DEFAULT 'internal'
    CHECK (classification IN ('internal', 'external', 'system')),

  -- Raw webhook payload kept for forensics. JSONB so we can re-parse if a
  -- bug ships in the extraction path.
  raw_payload JSONB,

  received_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Soft-delete: lets a user hide an accidentally-archived email without
  -- losing the row for audit. UI filters deleted_at IS NOT NULL.
  deleted_at TIMESTAMPTZ,
  deleted_by_user_id UUID
);

-- Dedup index — one (source, message_id) per record. NULL message_id is
-- not possible (NOT NULL above). A single email BCC'd to opp X and acc Y
-- legitimately creates two rows — the (source_kind, source_id) pair
-- differs so the UNIQUE doesn't collide.
CREATE UNIQUE INDEX IF NOT EXISTS commercial_archived_emails_dedup_idx
  ON public.commercial_archived_emails (source_kind, source_id, message_id);

-- Read path: newest-first list scoped to one parent. Most-common query.
CREATE INDEX IF NOT EXISTS commercial_archived_emails_source_received_idx
  ON public.commercial_archived_emails (source_kind, source_id, received_at DESC)
  WHERE deleted_at IS NULL;

-- Threading: lookup by Message-ID for in_reply_to chasing. Sparse so it's
-- cheap even with millions of rows.
CREATE INDEX IF NOT EXISTS commercial_archived_emails_inreplyto_idx
  ON public.commercial_archived_emails (in_reply_to)
  WHERE in_reply_to IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════
-- 2. Storage bucket: commercial-email-attachments
-- ════════════════════════════════════════════════════════════════════════
-- Karan must create the bucket via Supabase UI (matches the existing
-- commercial-account-docs + commercial-opp-attachments pattern):
--
--   Name: commercial-email-attachments
--   Public: NO (private)
--   File size limit: 25 MB
--   Allowed MIME types: leave empty (accept whatever Resend forwards)
--
-- Object path convention (built in lib/commercial/email-archive/inbound.ts):
--   emails/{source_kind}/{source_id}/{archived_email_id}/{sanitized_filename}
--
-- Downloads go through a server route that re-verifies the user can see
-- the parent record before issuing a 5-minute signed URL.

-- ════════════════════════════════════════════════════════════════════════
-- Comments
-- ════════════════════════════════════════════════════════════════════════
COMMENT ON TABLE public.commercial_archived_emails IS
  'BCC-archived emails per opportunity or account. Lets the team see the full Gmail conversation inside the Commercial CC.';
COMMENT ON COLUMN public.commercial_archived_emails.body_truncated IS
  'True when body_text was clipped at 200KB. Full original lives in raw_payload + attachments[*].storage_key.';
COMMENT ON COLUMN public.commercial_archived_emails.classification IS
  'internal = PPP-domain sender. external = third-party (GC / customer / etc). system = bounce or auto-reply.';
