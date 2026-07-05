# Phase 3 — Invoicing & Revenue Dashboard

**Locked:** 2026-07-05
**Owner:** Karan (build) · Alex (business consumer) · Katie (feedback)
**Scope:** 7 batches / ~14–18h · Postgres-native, no Salesforce coupling.

---

## Why Phase 3 first

Phase 2 (Opportunity Pipeline) ends the moment a bid moves to **Won**. Nothing
downstream tracks who paid what, how much is outstanding, or the running
revenue number Alex needs to report to Ari. Phase 3 closes that loop:

1. Convert a Won opp into an invoice with one click.
2. Track sent · viewed · paid · overdue per invoice.
3. Roll it all up into a **Revenue** report (Sent vs Paid, Aging AR,
   customer top-N).

Phases 4–9 (Contract Award, Project Setup, Execution, Change Orders,
Closeout) all consume the invoice + payment record downstream. Getting
the money model right first prevents downstream rework.

---

## Non-goals

- **Estimates** — Karan 2026-06-24 decision: Phase 3 ships invoicing WITHOUT
  a formal estimates surface. May add back as Phase 3.5 if Alex asks for
  "what we quoted vs what we billed" history.
- **Payment processing** — record-keeping only. No Stripe / ACH rails. Alex
  reconciles from bank / QB and clicks "Mark paid."
- **Tax calculations** — one flat "Tax %" field per invoice, painter enters
  the number. NYC sales tax is uniform across commercial paint jobs so this
  suffices for launch.
- **PDF invoice generation** — deferred to a Batch 6 stretch goal (react-pdf
  already wired for Letter of Transmittal, so the delta is one page + one
  route). Can ship v1 with browser print-to-PDF.
- **Multi-currency** — USD only.

---

## Data model

Two tables, one enum. Everything keyed off `commercial_opportunities.id`
so the invoice always inherits customer + property from the parent bid.

### `commercial_invoices`
```
id                     UUID PK (gen_random_uuid())
opportunity_id         UUID  FK → commercial_opportunities(id) ON DELETE RESTRICT
account_id             UUID  FK → commercial_accounts(id)      ON DELETE RESTRICT
invoice_number         TEXT  NOT NULL   -- e.g. "PPP-INV-0001", human-friendly
status                 TEXT  NOT NULL DEFAULT 'draft'
                              CHECK (status IN
                                ('draft','sent','viewed','partial','paid','overdue','void'))
issued_at              TIMESTAMPTZ         -- null while draft
due_at                 TIMESTAMPTZ         -- null while draft; net-30 default from issued_at
sent_at                TIMESTAMPTZ         -- when email went out
viewed_at              TIMESTAMPTZ         -- Resend open-event captures
paid_at                TIMESTAMPTZ         -- set when balance = 0
voided_at              TIMESTAMPTZ

subtotal_cents         BIGINT NOT NULL DEFAULT 0
tax_pct                NUMERIC(5,3) NOT NULL DEFAULT 0
                              CHECK (tax_pct >= 0 AND tax_pct <= 100)
tax_cents              BIGINT GENERATED ALWAYS AS
                              (ROUND(subtotal_cents * tax_pct / 100)) STORED
total_cents            BIGINT GENERATED ALWAYS AS
                              (subtotal_cents + ROUND(subtotal_cents * tax_pct / 100)) STORED
paid_cents             BIGINT NOT NULL DEFAULT 0
                              CHECK (paid_cents >= 0 AND paid_cents <= total_cents)
balance_cents          BIGINT GENERATED ALWAYS AS
                              (subtotal_cents + ROUND(subtotal_cents * tax_pct / 100) - paid_cents) STORED

payment_terms          TEXT   DEFAULT 'Net 30'
notes                  TEXT              -- internal, never on customer PDF
customer_message       TEXT              -- appears above line items on PDF
po_number              TEXT              -- customer PO for their AP system

created_by_user_id     UUID FK → auth.users(id)
created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
deleted_at             TIMESTAMPTZ       -- soft delete

UNIQUE (invoice_number)
```

### `commercial_invoice_line_items`
```
id                     UUID PK (gen_random_uuid())
invoice_id             UUID FK → commercial_invoices(id) ON DELETE CASCADE
position               INT NOT NULL DEFAULT 1000   -- sparse for drag-reorder
description            TEXT NOT NULL
quantity               NUMERIC(12,2) NOT NULL DEFAULT 1
                              CHECK (quantity > 0)
unit                   TEXT              -- "sqft", "hrs", "each", null
unit_price_cents       BIGINT NOT NULL
                              CHECK (unit_price_cents >= 0)
subtotal_cents         BIGINT GENERATED ALWAYS AS
                              (ROUND(quantity * unit_price_cents)) STORED

created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
```

### `commercial_invoice_payments`
```
id                     UUID PK
invoice_id             UUID FK → commercial_invoices(id) ON DELETE CASCADE
amount_cents           BIGINT NOT NULL CHECK (amount_cents > 0)
paid_at                TIMESTAMPTZ NOT NULL DEFAULT now()
method                 TEXT              -- "check", "ach", "wire", "credit_card", "other"
reference              TEXT              -- check #, wire confirmation, memo
notes                  TEXT
recorded_by_user_id    UUID FK → auth.users(id)
created_at             TIMESTAMPTZ NOT NULL DEFAULT now()

-- Trigger recomputes commercial_invoices.paid_cents on insert/update/delete
-- so status auto-flips draft → sent → partial → paid → overdue.
```

### `commercial_invoice_status_log` (audit trail)
Mirrors `commercial_opp_status_log` pattern — one row per transition, needed
for "days from sent → paid" reports.

---

## Status DAG

```
draft ─── send email ───► sent ─── open event ───► viewed
   │                          │                         │
   │                          └── payment landed ──►  partial ── balance=0 ─► paid
   │
   └── void ────────────► void   (from any pre-paid state)

paid + overdue are terminal for reporting. Overdue = sent + due_at < now()
and balance > 0. Computed, not stored — recomputed on read.
```

Enforced in `lib/commercial/invoices/status.ts`, same pattern as opp DAG.

---

## Migrations

**042_commercial_invoices.sql** — three tables above + status log + indexes
(invoice_number lookup, opportunity_id/status composite for the list page,
account_id/status composite for the account tab). All `IF NOT EXISTS`.

**042b_invoice_number_sequence.sql** — Postgres SEQUENCE for auto-generating
`PPP-INV-####` on create. Backfill starts at 0001 (Alex confirms Ari doesn't
need continuity with any prior QB numbering).

**042c_paid_cents_trigger.sql** — trigger on `commercial_invoice_payments`
that recomputes `commercial_invoices.paid_cents = SUM(payments.amount_cents)`.
Fires on INSERT / UPDATE / DELETE.

---

## Batches

### Batch 0 — Pre-audit (2 parallel Explore agents, 45m)

Agent A: audit the Phase 2 opp detail page. Where does "Convert to invoice"
live once the button is added? What's the smallest disruption to existing
tabs?

Agent B: audit `lib/commercial/opportunities` for hidden coupling. If an
invoice references opp_id, does the opp soft-delete path need to prevent
delete when an invoice exists? (Answer: ON DELETE RESTRICT + amber banner.)

### Batch 1 — Schema + lib scaffold (~2h)

- Migration 042 + 042b + 042c
- `lib/commercial/invoices/db.ts` — CRUD + list helpers
- `lib/commercial/invoices/status.ts` — DAG + `changeInvoiceStatus()`
- `lib/commercial/invoices/constants.ts` — DEFAULT_PAYMENT_TERMS, OVERDUE_GRACE_DAYS
- `lib/commercial/invoices/guards.ts` — verifyInvoiceEditable pattern from Phase 2.5
- Types

### Batch 2 — Invoice detail page (~3h)

- `/commercial/invoices/[id]/page.tsx`
- Header: invoice number + status pill + amount + due date
- Tabs: Details · Line items · Payments · Activity
- Actions: Send · Mark paid · Add payment · Void · Duplicate
- "Convert to invoice" button on opp detail lands here with the invoice
  pre-populated (title + account + property from opp)

### Batch 3 — Invoice list page (~2h)

- `/commercial/invoices/page.tsx`
- Same shape as opportunities list: KPI strip + search + sort/filter + rows
- KPIs: **Outstanding**, **Overdue**, **Paid this month**, **Draft**
- Filters: status · date range · account
- Row: number · account · issued · due · amount · balance · status pill

### Batch 4 — Payments UI (~2h)

- Add-payment modal (amount / date / method / reference / notes)
- Payment log on invoice detail
- Delete/edit within 24h grace, log-only after (compliance)
- Trigger already updates parent — no manual paid_cents math in the UI

### Batch 5 — Revenue report (~3h)

- `/commercial/reports/revenue/page.tsx`
- Unlock the disabled sidebar entry (already scaffolded)
- Panels:
  - **Invoiced vs Collected** trailing 12 months (bar chart)
  - **Aging AR** — 0-30 / 31-60 / 61-90 / 90+ buckets
  - **Top customers by revenue** — table with drill to /commercial/accounts/[id]
  - **Days-to-pay** median + p90
- Same period picker pattern as PPP CC

### Batch 6 — Cross-surface wiring + PDF stretch (~2h)

- Account 360 KPI strip: unlock "Invoiced" · "Paid" · "Balance" tiles
  (currently phase-8 placeholders)
- Opportunity detail: "Invoice" tab appears when opp.status = won
- Commercial CC landing dashboard: swap the "Wins this month" tile
  behavior to link to Revenue instead of Win/Loss
- Notification kinds: `invoice_overdue`, `invoice_paid` — hook the daily
  cron + Slack webhook + bell renderer
- **Stretch:** react-pdf invoice generator with logo + line items +
  payment info. Reuses the submittal-pdf pattern.

### Batch 7 — Post-audit + polish (~2h)

- 3 parallel Explore agents on each of: schema drift, opp→invoice
  coupling, mobile
- Triage findings + fix real bugs
- Update `PPP_Alex_Platform_Invoice.md` with actual hours
- Save memory: `project_phase_3_shipped.md`
- Regenerate `docs/COMMERCIAL_CC_MANUAL_STEPS.md` with migration 042
  paste instructions

---

## Copy conventions

- Never expose "opportunity" to the customer PDF — that's an internal term.
  Use "Project" on line items when derived from an opp.
- Never expose Postgres UUIDs — always the `invoice_number` (`PPP-INV-1042`).
- Status pill copy: **Draft · Sent · Viewed · Partial · Paid · Overdue · Void**
  (title case, no "In progress" or verbs).

---

## Open questions for Katie / Alex

1. **Invoice numbering** — start at `PPP-INV-0001` or continue from a QB
   number? (Assumption: start fresh.)
2. **Net-terms default** — Net 30 or Due on Receipt for commercial?
3. **Late fees** — track? Recognize as separate line, or informational only?
4. **Retainage** — commercial jobs often withhold 10% until closeout. Ship
   v1 without or bake in as a first-class field on the invoice?
5. **QuickBooks export** — Alex mentioned in Phase 2 kickoff. Ship v1 with
   CSV export or add QB API sync as Phase 3.5?

Answer required for Batches 1 (schema) and 5 (report). Batch 1 can proceed
with defaults if answers slip; retainage is the only one that affects the
schema — worth locking before Batch 1 lands.

---

## Success criteria

Alex can:
- Take a Won opp, click **Convert to invoice**, review 2 line items, click
  **Send** → email lands with the invoice info.
- Get paid → open the invoice → click **Add payment** → status auto-flips
  to Paid.
- Open the Revenue dashboard and see outstanding + top customers with real
  numbers.

Katie can:
- See a paid invoice roll up on the Account 360 KPI strip.
- See "Invoice sent" appear in the account Activity feed.

Karan can:
- Ship the whole phase in one push before Friday.
