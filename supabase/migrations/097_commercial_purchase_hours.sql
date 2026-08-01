-- Labor hours on a project purchase (Phase 2 labor form).
-- Paste-safe: one short idempotent statement. App writes the value; no DB default.
ALTER TABLE commercial_project_purchases ADD COLUMN IF NOT EXISTS hours numeric;
