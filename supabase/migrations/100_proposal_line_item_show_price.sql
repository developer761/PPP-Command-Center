-- R1a: per-line "show price on client PDF" toggle. Default true (current behavior).
-- Hidden lines still count toward the proposal total (app enforces).
ALTER TABLE commercial_proposal_line_items ADD COLUMN IF NOT EXISTS show_price boolean NOT NULL DEFAULT true;
