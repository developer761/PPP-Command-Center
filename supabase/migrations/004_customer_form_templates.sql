-- Customer-form template overrides
-- ------------------------------------------------------------------
-- Editable copy for the customer-color-form pipeline. Lets Katie/Karan
-- tweak the email subject, email body intro, form intro text, and form
-- thank-you message without a code deploy.
--
-- Single-row table (id = 'default') — there's only one set of templates
-- per PPP install. Code defaults shipped in lib/customer-form/templates.ts
-- act as the FALLBACK when a column is null; admin edits override.
--
-- Variables substituted at send/render time:
--   {{customer_name}}   — null-safe; falls back to "there"
--   {{customer_first}}  — first word of customer_name
--   {{wo_number}}       — Salesforce WorkOrderNumber (e.g. "00012345")
--   {{form_url}}        — full /select/<token> URL (email only)
--   {{ppp_brand}}       — "Precision Painting Plus" (constant)
--
-- Safe to re-run via IF NOT EXISTS guards (PPP has no migration runner
-- per the repo's deploy conventions).

CREATE TABLE IF NOT EXISTS customer_form_templates (
  id TEXT PRIMARY KEY DEFAULT 'default',
  -- Email invite ─────────────────────────────────────────────
  email_subject TEXT,           -- e.g. "Action needed: Pick your paint colors (WO #{{wo_number}})"
  email_intro TEXT,             -- first paragraph of the email body
  email_outro TEXT,             -- closing paragraph (above sign-off)
  email_signoff TEXT,           -- "Thanks, Precision Painting Plus" style line
  -- Form copy ─────────────────────────────────────────────────
  form_header_eyebrow TEXT,     -- small uppercase label above the H1
  form_header_title TEXT,       -- main H1 (use {{customer_first}} for personalization)
  form_header_subtitle TEXT,    -- one-line description below the H1
  form_intro_body TEXT,         -- longer paragraph (legacy single-paragraph mode)
  form_global_notes_label TEXT, -- label above the "anything else?" textarea
  form_thankyou_title TEXT,     -- H1 after submit
  form_thankyou_body TEXT,      -- paragraph below thank-you H1
  -- Audit
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id UUID,
  CONSTRAINT customer_form_templates_id_chk CHECK (id = 'default')
);

-- Seed the default row if it doesn't exist. Columns stay NULL so the
-- code defaults from lib/customer-form/templates.ts apply until the
-- admin actually edits something.
INSERT INTO customer_form_templates (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;

-- updated_at touch trigger so the admin UI always shows fresh "last edited"
CREATE OR REPLACE FUNCTION customer_form_templates_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customer_form_templates_touch_trigger ON customer_form_templates;
CREATE TRIGGER customer_form_templates_touch_trigger
  BEFORE UPDATE ON customer_form_templates
  FOR EACH ROW
  EXECUTE FUNCTION customer_form_templates_touch_updated_at();

COMMENT ON TABLE customer_form_templates IS
  'Editable copy for the Customer Color Form pipeline. Single-row table (id=default). Null columns fall back to code defaults in lib/customer-form/templates.ts.';
