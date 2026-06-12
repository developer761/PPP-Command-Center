-- Migration 018: In-app notifications (the bell).
--
-- Why: Katie + Alex 2026-06-12 — when a customer submits a color form, the
-- rep who sent it AND every admin should see a notification bell light up.
-- Workers must only see notifications for THEIR work orders; admins see all.
--
-- Design: one row per recipient. We fanout at insert time (one row per admin
-- + one row for the WO owner). That keeps read-state per-user simple
-- (read_at flips on a single row, no cross-user state) and the GET endpoint
-- is a single WHERE recipient_user_id = ? — no scope/join logic at read
-- time, so a worker physically cannot read another rep's notifications.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The Supabase auth user who should see this row. Scoping is enforced
  -- here: a worker's GET filters by recipient_user_id = themselves, so they
  -- physically cannot read another rep's notifications.
  recipient_user_id UUID NOT NULL,

  -- Event kind. Today: 'customer_form_submitted'. Forward-compat for future
  -- bells (supplier email bounced, materials order placed, etc.) without
  -- needing another table.
  kind TEXT NOT NULL,

  -- Optional WO context. Stored as the SF 18-char Id; nullable for non-WO
  -- notification kinds added later.
  work_order_id TEXT,
  work_order_number TEXT,
  customer_name TEXT,

  -- Display payload.
  title TEXT NOT NULL,
  body TEXT,
  -- Where clicking the bell row takes you (relative URL).
  link TEXT,

  -- null = unread. Flipped to NOW() when the recipient reads it.
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: load this user's unread + recent rows.
-- Composite covers WHERE recipient_user_id = ? ORDER BY created_at DESC
-- and WHERE recipient_user_id = ? AND read_at IS NULL.
CREATE INDEX IF NOT EXISTS notifications_recipient_created_idx
  ON notifications (recipient_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_recipient_unread_idx
  ON notifications (recipient_user_id)
  WHERE read_at IS NULL;
