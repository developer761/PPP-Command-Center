-- 144 — the order gets built once, then fulfilment reads it.
--
-- Kate round-3 #18: "Order Materials currently does two jobs at once, and we
-- think most of the issues on this page are symptoms of that."
--
-- She is right, and the code agrees with her. Everything the worker typed on
-- the order screen lived in React state inside a modal, and the modal re-fetched
-- its draft whenever ANY input changed — extras, fulfilment method, product
-- line. That refetch cleared the typed quantities (supplier-order-modal.tsx
-- cleared the override map on every draft response), so:
--
--   #22  quantities reset the moment an extra was added
--   #23  a per-colour product line arrived with "(PPP to confirm quantities)"
--   #20  a tab switch re-mounted the modal and lost everything
--
-- One table fixes the class. Order BUILDING (what to buy) commits here when the
-- worker advances to fulfilment; the fulfilment step then reads this payload
-- instead of re-deriving it, so changing a delivery address can no longer
-- mutate the order.
--
-- One row per (work order, supplier). Re-entering the builder resumes exactly
-- where the worker left off, which is also what makes #20 survivable: a remount
-- reloads the row rather than starting from nothing.

create table if not exists public.supplier_order_builds (
  id                  uuid primary key default gen_random_uuid(),
  work_order_id       text not null,
  supplier_account_id text not null,
  -- The committed order payload:
  --   { mainMaterialType, materialTypeOverrides, quantities, extras,
  --     customColorItems, colorNotes }
  -- Held as jsonb rather than columns because it is one atomic worker
  -- decision — it is always read and written whole, never queried by field.
  payload             jsonb not null default '{}'::jsonb,
  -- Set when the worker advances to fulfilment. A row with a null
  -- committed_at is an in-progress build (autosaved), which is what lets the
  -- builder survive a remount without pretending the order is ready to send.
  committed_at        timestamptz,
  created_by_user_id  uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (work_order_id, supplier_account_id)
);

create index if not exists supplier_order_builds_wo_idx
  on public.supplier_order_builds (work_order_id);

alter table public.supplier_order_builds enable row level security;

-- Server-side only: every read/write goes through the admin client in
-- /api/admin/supplier-order/build, which gates on canOrderMaterials. No
-- anon/authenticated policy on purpose — matches supplier_orders.
drop policy if exists supplier_order_builds_no_client on public.supplier_order_builds;

comment on table public.supplier_order_builds is
  'Committed "what to buy" state per (work order, supplier). Written by the order builder, read by the fulfilment step so fulfilment edits cannot mutate the order payload. Kate round-3 #18.';
comment on column public.supplier_order_builds.committed_at is
  'Null = in-progress autosave; set = worker advanced to fulfilment.';
