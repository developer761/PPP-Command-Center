-- 154 · Collection notes for the receivables report. (Alex, 2026-08-19)
--
-- Alex sent the AR sheet Mary maintains by hand and asked for the same thing in
-- the platform. Its three columns are Job · Billed/Open · Notes, and the Notes
-- column is the only one a machine can't produce:
--
--   "8/13 - s/b paid within 2 weeks"
--   "8/19/26 asked for update"
--   "Need to complete doors in the Spring"
--
-- Everything else on that sheet we already hold — "AIA#3-7/22/26" is an
-- application number and an issue date. This table is for the part that is
-- genuinely a person's knowledge, so it stops living in one spreadsheet on one
-- laptop.
--
-- A SEPARATE table rather than reusing commercial_invoices.notes, for three
-- reasons:
--   1. That column already means something else ("internal notes; never on the
--      customer copy"), and writing chase notes into it would clobber real data.
--   2. A receivable can be an AIA application or a retainage balance, neither of
--      which is an invoice row at all — retainage isn't a record anywhere, it's
--      a derived figure, so it has nowhere else to hang a note.
--   3. Notes outlive their subject. An invoice gets paid and drops off the
--      report; the history of how it got chased is still worth having.
--
-- Keyed by the report's own row key (`invoice:<uuid>` / `aia:<uuid>` /
-- `retainage:<opp-uuid>`) rather than an FK, precisely because kind 3 has no
-- table to point at. The prefix keeps the namespaces from colliding.

create table if not exists commercial_receivable_notes (
  id uuid primary key default gen_random_uuid(),
  -- e.g. 'invoice:8f3c…', 'aia:1b90…', 'retainage:44de…'
  row_key text not null unique,
  note text not null,
  updated_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table commercial_receivable_notes is
  'Collection/chase notes shown on the receivables report. Keyed by the report row key (invoice:/aia:/retainage: + id) because a retainage row has no underlying record to reference.';

comment on column commercial_receivable_notes.row_key is
  'kind:id — invoice:<invoice_id>, aia:<application_id>, retainage:<opportunity_id>.';

-- The report loads every note in one query and joins in memory, so the unique
-- index on row_key is the only one it needs.
create index if not exists commercial_receivable_notes_updated_idx
  on commercial_receivable_notes (updated_at desc);
