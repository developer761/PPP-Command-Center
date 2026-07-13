# Phase D — Product Library + Customer-Specific Prices

**Locked 2026-07-13 · executed by Claude at Karan's kickoff.**

## Why

Every deal Alex writes has line items (paint SKUs, sundries, labor). Today they're free-text entries on the invoice form — no catalog, no unit-cost tracking, no way for Tomco (or any repeat customer) to lock in negotiated prices per SKU.

Phase D introduces a real product catalog + per-customer price overrides so:
1. Alex picks products from a searchable dropdown instead of retyping every time.
2. Line items auto-fill: description, unit, default price.
3. For customers like Tomco with negotiated pricing, the customer-specific price wins over the default.
4. Cost tracking lets PPP see margin per line without a spreadsheet.

## Scope — two tables + admin UI + one consumer wire-in

### `commercial_products` (catalog)
| column | type | notes |
|---|---|---|
| id | UUID PK | `gen_random_uuid()` |
| sku | TEXT UNIQUE | e.g. `BM-AURA-INT-SG` |
| name | TEXT NOT NULL | e.g. `Benjamin Moore Aura Interior Semi-Gloss` |
| category | TEXT | `paint` / `sundry` / `labor` / `other` |
| unit | TEXT | `gallon` / `hour` / `each` / `linear_foot` / `square_foot` |
| default_unit_cost_cents | INTEGER | what PPP pays (margin math) |
| default_unit_price_cents | INTEGER NOT NULL | retail |
| notes | TEXT | free-text for internal reference |
| is_active | BOOLEAN default true | soft archive vs true delete |
| created_at / updated_at | timestamptz | trigger-managed |
| deleted_at | timestamptz nullable | soft delete for real removal |
| created_by_user_id / updated_by_user_id | UUID FK auth.users | audit trail |

Indexes: `sku` unique, `name` ilike-friendly, `is_active + deleted_at` partial for the picker's fast path.

### `commercial_customer_prices` (per-account overrides)
| column | type | notes |
|---|---|---|
| id | UUID PK | |
| account_id | UUID FK commercial_accounts | ON DELETE CASCADE |
| product_id | UUID FK commercial_products | ON DELETE CASCADE |
| unit_price_cents | INTEGER NOT NULL | Tomco's negotiated rate |
| effective_from | DATE | when this price kicks in (nullable = current) |
| notes | TEXT | contract ref, memo |
| created_at / updated_at | timestamptz | |

Unique constraint on `(account_id, product_id, effective_from)` — one row per SKU per account per activation date. Old rates preserved for history.

## Resolution rule (single source of truth)

`resolveProductPrice({ productId, accountId?, atDate? })` returns:
1. If `accountId` given AND a `commercial_customer_prices` row exists for that (account, product) with `effective_from <= atDate`, use its `unit_price_cents`.
2. Otherwise use `commercial_products.default_unit_price_cents`.

## UI surfaces

### 1. `/commercial/settings/products` — catalog admin (Alex/Katie)
- List view: SKU · Name · Category · Unit · Default price · Active pill
- Filters: category, active/archived, search on SKU + name
- Actions: New product, edit row, archive
- CSV import for bulk seed (Tomco/BM/Sherwin lists)

### 2. `/commercial/settings/products/[id]` — product detail + customer prices
- Edit basic fields
- Nested table of every account with a customer-price override
- Add-override form (SearchableSelect picks the account, unit_price cents)

### 3. `<ProductPicker>` — reusable searchable dropdown
- SearchableSelect populated from live catalog
- Result rows show name + SKU + price (with badge if a customer-specific price applies)
- Wired into invoice line-item form: picking a product auto-fills description + unit_price

### 4. Sidebar entry
Under Settings group: **Products** (Catalog + prices).

## Consumer wire-in (this phase)

Only the **invoice line-item form** gets the ProductPicker. Future phases (Proposal Builder, submittals) will reuse the picker.

Server action `addLineItemAction` accepts an optional `product_id` — if present, snapshots the resolved price (customer override if applicable) into `unit_price_cents`. Description defaults to the product's `name` (editable). Line item stores `product_id` FK so future price changes don't rewrite historical invoices.

## Migration (050)

- Add `commercial_products` + `commercial_customer_prices` tables
- Add `product_id UUID` column to `commercial_invoice_line_items` (nullable — legacy line items have no product FK)
- Idempotent, rerun-safe with `IF NOT EXISTS`

## Post-launch queue (deferred, mentioned for context)

- Product bundles (paint + primer + sundries as one pick)
- Multi-tier pricing (contractor / retail / spec)
- Cost history + margin dashboards
- SKU barcode scanning on mobile

## Batches

- **Batch 1**: Migration 050 + lib scaffold (`lib/commercial/products/{db,pricing,constants}.ts`)
- **Batch 2**: Admin CRUD pages under `/commercial/settings/products`
- **Batch 3**: `ProductPicker` component + wire into invoice line-item form
- **Batch 4**: Post-audit + fixes + push

Standing rules apply on every batch (pre-audit + post-audit + type-check + push + invoice update).
