-- Confirmation ("receipt") email copy for the customer color form.
--
-- Kate 2026-10-01: "An automatic email to customer upon form submission as a
-- 'receipt' of customer's selections + include a button to the form to allow
-- them to make edits when needed."
--
-- Three more editable strings on the existing single-row templates table, so
-- the wording of the document meant to prevent a dispute can be changed from
-- Settings → Customer Copy rather than by a deploy.
--
-- NULL means "use the code default" — that is how loadTemplates() already
-- treats every column here, so adding these as nullable needs no backfill and
-- the email works before anybody edits anything.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.customer_form_templates
  ADD COLUMN IF NOT EXISTS confirm_subject TEXT,
  ADD COLUMN IF NOT EXISTS confirm_intro   TEXT,
  ADD COLUMN IF NOT EXISTS confirm_outro   TEXT;

COMMENT ON COLUMN public.customer_form_templates.confirm_subject IS
  'Subject of the receipt email sent to the customer on form submit. NULL = code default.';
COMMENT ON COLUMN public.customer_form_templates.confirm_intro IS
  'Opening paragraph of the receipt email, above the selections table. NULL = code default.';
COMMENT ON COLUMN public.customer_form_templates.confirm_outro IS
  'Closing paragraph of the receipt email, below the edit button. NULL = code default.';
