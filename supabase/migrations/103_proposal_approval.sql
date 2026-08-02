-- R1d: in-app approval hard gate. Paste-safe: one short idempotent statement per line.
ALTER TABLE commercial_proposals ADD COLUMN IF NOT EXISTS approval_requested_by_user_id uuid;
ALTER TABLE commercial_proposals ADD COLUMN IF NOT EXISTS approval_requested_at timestamptz;
ALTER TABLE commercial_proposals ADD COLUMN IF NOT EXISTS approved_by_user_id uuid;
ALTER TABLE commercial_proposals ADD COLUMN IF NOT EXISTS approval_approved_at timestamptz;
ALTER TABLE commercial_proposals ADD COLUMN IF NOT EXISTS changes_requested_note text;
ALTER TABLE commercial_proposals ADD COLUMN IF NOT EXISTS changes_requested_at timestamptz;
ALTER TABLE commercial_proposals DROP CONSTRAINT IF EXISTS commercial_proposals_status_check;
ALTER TABLE commercial_proposals ADD CONSTRAINT commercial_proposals_status_check CHECK (status IN ('draft','pending_approval','approved','sent','won','lost','expired','superseded'));
