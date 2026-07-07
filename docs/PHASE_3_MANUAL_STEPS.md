# Phase 3 · Invoicing — Manual Paste Steps

**Ship date:** 2026-07-07
**Deploy:** `git push` triggers Vercel auto-deploy. Migration must be pasted before or right after the deploy — the code has graceful fallbacks (returns zeros if the view/tables don't exist yet) but you'll see "Coming with Phase N"-style empty tiles until the SQL lands.

---

## 1) Paste this SQL migration into Supabase

Open the Supabase project's SQL Editor and paste the entire contents of
[`supabase/migrations/042_commercial_invoices.sql`](../supabase/migrations/042_commercial_invoices.sql) in one shot.

The migration is fully `IF NOT EXISTS`-safe — you can re-run it as many times as you want; it will not error on re-run.

**What it creates:**
- `commercial_invoices` — invoice header table with generated `total_cents` + `balance_cents`
- `commercial_invoice_line_items` — line items with sparse `position` INT for drag-reorder
- `commercial_invoice_payments` — payments log
- `commercial_invoice_status_log` — status transition audit trail
- `commercial_invoice_seq` — sequence + `next_commercial_invoice_number()` RPC for invoice numbering (PPP-INV-0001, 0002, …)
- Trigger `trg_recompute_paid_cents` — auto-flips invoice status to `partial`/`paid` when payments hit the balance
- View `commercial_account_invoice_rollup` — drives the Invoiced/Paid/Balance KPI tiles on Account 360

**Verification query** (paste after the migration runs):
```sql
select
  (select count(*) from commercial_invoices)              as invoices,
  (select count(*) from commercial_invoice_line_items)    as line_items,
  (select count(*) from commercial_invoice_payments)      as payments,
  (select count(*) from commercial_invoice_status_log)    as status_log,
  (select nextval('commercial_invoice_seq'))              as next_seq,
  (select count(*) from commercial_account_invoice_rollup) as rollup_rows;
```
`invoices/line_items/payments/status_log` should all be `0`, `next_seq` should be `2` (we just consumed 1 by peeking), and `rollup_rows` equals the count of your accounts.

**Undo:** Nothing that has a foreign-key check will let you drop these carelessly. If you must roll back, drop in this order (only if there are zero real rows):
```sql
drop view if exists commercial_account_invoice_rollup;
drop trigger if exists trg_recompute_paid_cents on commercial_invoice_payments;
drop function if exists recompute_invoice_paid_cents();
drop function if exists next_commercial_invoice_number();
drop sequence if exists commercial_invoice_seq;
drop table if exists commercial_invoice_status_log;
drop table if exists commercial_invoice_payments;
drop table if exists commercial_invoice_line_items;
drop table if exists commercial_invoices;
```

---

## 2) Environment variables

No new env vars for Phase 3. Uses the same `NEXT_PUBLIC_SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` the rest of Commercial CC uses.

---

## 3) Smoke-test after deploy

1. Sign in as an admin.
2. Sidebar → **Invoices** (should no longer be disabled). Landing shows the KPI strip (all zeros) + "No invoices yet" empty state.
3. Go to an opportunity currently in **Won** status. New button in the header: **Convert to invoice**. Click it.
4. You land on `/commercial/invoices/<uuid>` — a draft invoice, invoice number `PPP-INV-0001`, blank line items.
5. **Line items:** add one ("Interior painting · qty 1 · $5,000"). Subtotal + total update.
6. **Change status → Sent.** Timeline entry appears.
7. **Payment:** record $2,500. Status auto-flips to **Partial**. Log entry appears.
8. **Overpayment test:** record $10,000 on the remaining $2,500 balance. Amber toast appears explaining the cap ("You entered $10,000.00 but only $2,500.00 was owed"). Status flips to **Paid**.
9. Go back to the source Account. **Account 360 KPI strip:** Invoiced $5,000 · Paid $5,000 · Balance $0. Click Invoiced tile → lands on the Invoices list, filtered to this account with a blue banner.
10. Delete flow: create a fresh draft, delete it from the detail page → returns to list with blue toast "Draft invoice deleted."

---

## 4) Backfill (optional, for existing won opps)

If PPP has any historical Won opps that should get invoices, don't backfill them programmatically — Karan or Katie should walk through and convert each one manually via the **Convert to invoice** button so the invoice numbers stay sequential and the payment history is accurate.

---

## 5) What's next (Phase 4 and beyond, NOT in this ship)

- PDF export for invoices (`/api/commercial/invoices/[id]/pdf`)
- Send invoice email to GC + payment tracking pixel
- Multi-invoice-per-opp UI polish (currently allowed by the schema — progress billing — but not surfaced in the UI)
- Recurring / retainer invoicing
- Refunds workflow

None of these are blocking. Ship Phase 3 as-is.
