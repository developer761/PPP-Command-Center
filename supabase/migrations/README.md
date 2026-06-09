# Migrations

**No migration runner.** SQL files in this directory get pasted into the Supabase SQL editor by hand. Every migration is `IF NOT EXISTS` / `ON CONFLICT`-safe so re-running is a no-op.

The app must tolerate the migration being un-applied — e.g., `createToken` falls back to a narrower INSERT if the `kind` column isn't there yet. If you add a column the code reads, also add a fall-through in the caller for envs without the migration applied.

## How to apply

1. Open Supabase Dashboard → SQL Editor.
2. Paste the contents of the next un-run migration file (in numeric/alphabetic order).
3. Run. Confirm no errors.
4. Re-run if you're unsure whether it applied; the `IF NOT EXISTS` guards make it safe.

## Migration index

| File | What it does |
|---|---|
| `001_system_credentials.sql` | Encrypted credentials table (Salesforce OAuth refresh token, etc.). |
| `002_profiles_and_view_as.sql` | `profiles` table (admin flag, SF user id mapping) + `view_as_log` audit table. |
| `003_customer_form_tokens.sql` | The customer-form token system. Adds `kind` column for `preview` vs real sends. |
| `004_customer_form_templates.sql` | Email template overrides per template-key. |
| `005_supplier_orders.sql` | The supplier order header table (PO numbers, draft/sent state, audit timestamps). |
| `006_supplier_settings.sql` | Per-supplier config (active flag, sort order, pickup locations, etc.). |
| `007_supplier_extras.sql` | The "extras" catalog (rollers, tape, etc.) for supplier order drafts. |
| `008_supplier_email_templates.sql` | Per-supplier email subject/greeting/intro/outro/signoff overrides. |
| `009_inbox_messages.sql` | Mail Hub message threads + delivery state. |
| `010_email_delivery_tracking.sql` | Resend webhook delivery state per outbound message. |
| `011_snapshot_cache.sql` | Cross-instance shared SF snapshot blob (gzipped). |
| `011b_snapshot_generation.sql` | Generation counter for cross-instance cache invalidation. **Companion to 011, run together.** |
| `012_seed_delivery_vendors.sql` | Seeds the curated vendor list (Aboffs, Willis, etc.). |
| `012b_snapshot_generation_rpc.sql` | RPC for atomic-bump of the generation counter. **Companion to 012, run together.** |
| `013_paint_coverage_config.sql` | Tunable gallon-math constants (Settings → Coverage). |
| `014_supplier_settings_sort_order.sql` | `sort_order` column on `supplier_settings` for drag-reorder UI. |
| `015_customer_form_writeback_safety.sql` | The `customer_form_writeback_allowlist` table + writeback mode infra. |

## Naming convention

Files use a 3-digit numeric prefix to order them. When two migrations are part of the same conceptual change (e.g., a table + the RPC that operates on it), use a `b` suffix on the second (`011_x.sql` + `011b_y.sql`). Don't reuse a prefix outright — it makes "the 011 migration" ambiguous.

If you need to add a new migration:

1. Pick the next free prefix (e.g., `016`).
2. Name the file after WHAT IT DOES, not what feature shipped (`016_add_workflow_audit.sql` not `016_phase_3.sql`).
3. Add the row to the table above so a new dev can answer "what does this file do?" in 5 seconds.
4. Make it `IF NOT EXISTS` / `ON CONFLICT`-safe.
5. Test paste-and-run on a Supabase staging project before paste-and-running on prod.
