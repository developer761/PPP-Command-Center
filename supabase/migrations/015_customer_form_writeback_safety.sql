-- Migration 015: Customer form Salesforce writeback safety gates.
--
-- Why: Katie 2026-06-03 — PPP wants the customer form's color picks to
-- write back to Salesforce (CC → SF two-way sync), BUT during the
-- testing period we want that writeback gated to specific test work
-- orders so we don't accidentally corrupt real customer records.
--
-- Two tables:
--   customer_form_writeback_settings — one global row controlling mode
--     mode='test_only'  — only writes to WOs explicitly on the allowlist
--     mode='all'        — writes to every WO that submits (production)
--     mode='off'        — disables writeback entirely (full read-only mode)
--   customer_form_writeback_allowlist — WO ids that ARE allowed to write
--                                       in test_only mode
--
-- Safe default: mode='test_only' + empty allowlist = NO writes. Admin
-- adds test WO ids to the allowlist as Katie's team confirms each is
-- safe to write. Switching to mode='all' lifts the gate for production.
--
-- Re-runnable: every CREATE / INSERT is IF NOT EXISTS / ON CONFLICT.

CREATE TABLE IF NOT EXISTS customer_form_writeback_settings (
  key TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('test_only', 'all', 'off')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);

INSERT INTO customer_form_writeback_settings (key, mode)
VALUES ('global', 'test_only')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS customer_form_writeback_allowlist (
  work_order_id TEXT PRIMARY KEY,
  label TEXT,
  added_by TEXT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Token kind column — used to mark PREVIEW tokens so they're excluded
-- from Mail Hub Sent counts, SF writeback, and the form's "submitted"
-- lifecycle stamping. NULL = legacy "invite" token, behaves exactly as
-- before. New preview tokens carry kind='preview'.
ALTER TABLE customer_form_tokens
  ADD COLUMN IF NOT EXISTS kind TEXT;

CREATE INDEX IF NOT EXISTS customer_form_tokens_kind_idx
  ON customer_form_tokens (kind);
