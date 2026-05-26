# Phase 2 — Game Plan (v2, updated 2026-05-26)

**Status of week 2:** Customer Color Form pipeline shipped end-to-end last week. This week ships the supplier-side: Customer submits colors → progress bar advances → supplier email auto-generates with everything pre-filled → worker reviews + adds extras from a dropdown + picks delivery vs pickup → sends → reply lands in Command Center inbox → status advances.

Architecture decisions in this doc fold in **all** of Karan's requirements (progress bar timeline, customer email migration, 20-item dropdown, pickup-vs-delivery, replies in Command Center) and the **26 edge cases** identified in the pre-execution audit.

---

## What's already shipped (customer side, complete)

| Piece | Where | Status |
|---|---|---|
| Token system (32-byte, 30-day lifecycle, sent / opened / submitted / expired) | `lib/customer-form/tokens.ts` + migration 003 | ✅ |
| Resend on `orders.precisionpaintingplus.net` (DKIM + SPF verified) | `lib/email/resend.ts` | ✅ |
| Admin "Send Color Form" modal on `/dashboard/materials` | `components/materials-view.tsx` | ✅ |
| Public branded form `/select/[token]` | `app/select/[token]/page.tsx` | ✅ |
| **Form scoped to ONLY the WOLI rows the estimator tagged for this WO** | `lib/customer-form/render-data.ts` | ✅ |
| Instant color search (5,762 colors, client-side filter, 1h browser cache) | `app/api/customer-form/colors/all` | ✅ |
| Submit → SF write-back (drift-detected, retried, audited) | `app/api/customer-form/submit/[token]` + `lib/salesforce/writeback.ts` | ✅ |
| Form-status badges (Sent / Opened / Submitted / Expired) on materials page | `lib/customer-form/wo-status.ts` | ✅ |
| Editable email + form templates (no deploy needed) | `lib/customer-form/templates.ts` + migration 004 | ✅ |

---

## Phase 2A — Customer email + form auto-populate (Wed)

### A.1 Pull customer email + address into the SF snapshot
Account snapshot currently misses two critical fields. Adding:
- `Account.PersonEmail` (customer email — Person Account model) OR `Account.Email` (custom field if PPP uses business Accounts)
- `Account.BillingStreet`, `BillingCity`, `BillingState`, `BillingPostalCode` (delivery address default)

Adds ~15 chars of payload per Account. Negligible impact.

### A.2 Pre-fill the "Send Color Form" modal
- Email field pre-populated from `Account.PersonEmail`
- Yellow chip "no email on file" when SF returns null → admin types manually + the value is written BACK to SF Account.PersonEmail so next time it's there
- Customer name pre-populated from `Account.Name`
- Validation: email shape + domain check (block sending to `@precisionpaintingplus.*` to avoid accidentally sending to PPP staff)

### A.3 Customer email migration (back-fill what's already in SF)
- One-shot script `/api/admin/customer-email-backfill` (admin-only) — scans all Accounts, reports how many have email vs missing
- Surface counts on a new `/dashboard/settings/customer-data` admin page: "X of Y customers have email on file. Click below to filter the WO list to ones missing email so you can add it."
- Per-WO: the materials page's WO card shows a small "add email" icon when email is missing → opens a 1-field modal → writes back to SF

---

## Phase 2B — Progress Bar Timeline (Wed)

Per Karan's explicit ask, every WO needs a visible **stage timeline** so PPP staff see exactly where this customer is in the pipeline.

### B.1 Stage model

```
[Form Sent] → [Customer Opened] → [Customer Submitted] → [Supplier Order Drafted] → [Supplier Order Sent] → [Supplier Confirmed] → [Materials Delivered] → [Job Complete]
   ✓ 5/26      ✓ 5/26                ✓ 5/27                    ✓ 5/27                  ✓ 5/27               (waiting on BM)         —                         —
   2:14pm      2:51pm                 9:22am                     10:01am                 10:03am
```

### B.2 Component: `<WorkOrderProgressBar woId={...} />`
- Horizontal stepper, mobile-responsive (becomes vertical on `<sm`)
- Each step: dot + label + timestamp when reached (or "—" if not)
- Color coding: green = complete, blue = current, charcoal = not yet, orange = stuck (e.g., form sent but customer hasn't opened in 3+ days)
- Renders in two places:
  1. **Sticky strip at the top of the right detail pane** in `/dashboard/materials` (above line items)
  2. **Rep profile** `/dashboard/rep/[id]/page.tsx` — at the top of each Upcoming Work row (collapsed; expand for full timeline)

### B.3 Data source
- Stages 1-3 (form sent / opened / submitted) — from `customer_form_tokens` (already exists)
- Stages 4-6 (supplier drafted / sent / confirmed) — from `supplier_orders` (new — see §C)
- Stages 7-8 (delivered / complete) — admin marks via the timeline component (clicks "Mark delivered" → updates `supplier_orders.delivered_at` + WO status indirectly)

### B.4 Edge cases handled
- Form never sent (no token yet) → entire bar shows as "not started" with a "Start: Send Color Form →" CTA
- Customer never opens form (stuck at "sent" for 3+ days) → step turns orange + "Send reminder" CTA appears
- Customer opens but doesn't submit (stuck at "opened" for 5+ days) → step turns orange + "Resend with new link" CTA
- Multiple suppliers per WO → stages 4-6 each get a sub-row per supplier ("BM drafted ✓ · SW drafted ✓ · BM sent ✓ · SW sent —")

---

## Phase 2C — Supplier email auto-generation + extras dropdown (Wed-Thu)

### C.1 `supplier_orders` table (migration 005)

```sql
CREATE TABLE supplier_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id TEXT NOT NULL,
  work_order_number TEXT,
  supplier_account_id TEXT NOT NULL,        -- SF Account.Id of the supplier
  supplier_name TEXT NOT NULL,              -- denormalized for display
  po_number TEXT NOT NULL UNIQUE,           -- e.g. PPP-WO00012345-BM-001
  draft_body TEXT,                          -- admin-edited final email body
  special_instructions TEXT,                -- freeform admin notes
  -- Delivery
  fulfillment_method TEXT NOT NULL,         -- 'delivery' (default) | 'pickup'
  delivery_address JSONB,                   -- full address; null when pickup
  pickup_location TEXT,                     -- supplier store ref; null when delivery
  required_by_date DATE,
  -- Line items
  line_items JSONB NOT NULL,                -- normalized array (see C.2)
  extras JSONB DEFAULT '[]'::jsonb,         -- worker-added extras from dropdown
  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'draft',     -- draft / sent / acknowledged / delivered / cancelled / failed
  sent_at TIMESTAMPTZ,
  sent_to_email TEXT,
  resend_message_id TEXT,
  acknowledged_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  failure_reason TEXT,
  -- Audit
  created_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Dedupe guard — prevents accidental double-send on rapid click
  CONSTRAINT supplier_orders_no_dup_send UNIQUE (work_order_id, supplier_account_id, status)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX supplier_orders_wo_idx ON supplier_orders (work_order_id);
CREATE INDEX supplier_orders_status_idx ON supplier_orders (status, updated_at DESC);
```

### C.2 `lib/supplier-order/builder.ts`
Auto-generates a draft from snapshot data + the customer's submitted picks + worker's extras + delivery mode:

```typescript
buildSupplierOrderDraft({
  workOrder,                  // SnapshotWorkOrder
  customerToken,              // CustomerFormToken (submitted)
  supplierAccountId,          // BM / SW / etc.
  fulfillmentMethod,          // 'delivery' | 'pickup'
  extras,                     // Array<ExtraItem> from worker dropdown
  specialInstructions,        // freeform
}): SupplierOrderDraft
```

Returns:
- `poNumber` — auto-generated, format `PPP-{woNumber}-{supplierCode}-{nnn}`. NEXT_VAL via DB sequence to prevent race collisions.
- `emailBody` — formatted plain-text:
  ```
  To: orders@benjaminmoore.com    ← Phase 2C.5
  From: orders@orders.precisionpaintingplus.net
  Reply-To: orders@orders.precisionpaintingplus.net   ← lands in Command Center inbox
  Subject: PPP Order #PPP-WO00012345-BM-001 — Jane Smith (WO 00012345)

  Hi Benjamin Moore team,

  Please prepare the following order:

  PPP Account: [PPP_BM_ACCOUNT_NUMBER env var]
  PO Number: PPP-WO00012345-BM-001
  Required by: Wed May 29

  CUSTOMER + JOB
  Customer: Jane Smith
  Work Order: #00012345
  Job scheduled: Fri May 31
  Fulfillment: DELIVERY to customer address
  Deliver to:
    Jane Smith
    123 Main St
    Smithtown, NY 11787

  COLORS

  Interior — Master Bedroom
  - Walls — Stardust (2108-40), Regal Select Eggshell × 2 gal
  - Trim  — White Heron (OC-57), Advance Semi-Gloss × 1 gal

  Interior — Living Room
  - Walls — Smoky Taupe (983), Regal Select Eggshell × 3 gal

  EXTRAS (added by PPP worker)
  - 9" microfiber roller covers × 6
  - 2" angled sash brush × 2
  - 12oz painter's tape × 4
  - 9×12 canvas drop cloth × 2

  SPECIAL INSTRUCTIONS
  Customer prefers AM delivery. Garage code is in scheduling notes.

  Reply to this email to confirm + provide delivery date / tracking.

  Thanks,
  Precision Painting Plus
  ```

- `quantityEstimates` — per-color: `Math.ceil(sqft × coats / coveragePerGallon)` with `coveragePerGallon` defaulting to 350 (admin can override per line)

### C.3 The 20-item Extras Dropdown

Catalog stored in `supplier_extras` table (migration 005b) so PPP can edit without a deploy:

```sql
CREATE TABLE supplier_extras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,                 -- "9 inch microfiber roller cover"
  unit TEXT NOT NULL DEFAULT 'each',  -- each / box / case / gallon
  default_qty INTEGER DEFAULT 1,
  -- Optional preferred supplier — if set, only shown for that supplier
  preferred_supplier_id TEXT,
  -- Active flag for soft-removal
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed Karan's 20 items via INSERT statements (admin can edit/add via UI later)
INSERT INTO supplier_extras (name, unit, default_qty, sort_order) VALUES
  ('9" microfiber roller cover', 'each', 6, 10),
  -- ...19 more, awaiting Karan's list
  ;
```

**Admin UI**: new section on `/dashboard/settings/templates` ("Extras catalog") lets admin add / edit / disable items in the same editor pattern.

**Worker UI** (supplier order modal):
- Multi-select chips for the extras
- Per-extra qty stepper (default from `supplier_extras.default_qty`)
- Selected items append to the EXTRAS section of the draft email body
- Searchable when the catalog grows beyond 20 items

### C.4 Pickup vs Delivery toggle

Radio buttons in the draft modal:
- **Delivery to customer** (DEFAULT for most jobs) → uses customer address from form submission OR Account.BillingAddress fallback. The address chip shows "From customer form" or "From SF Account" so admin knows the source. Admin can override.
- **Pickup at supplier** (rare edge case) → admin picks supplier branch from a small dropdown (or types). Email body changes from "Please deliver to:" → "We will pick up at your [Smithtown] store on [date]"

Stored as `fulfillment_method` + `delivery_address` JSON or `pickup_location` text in `supplier_orders`.

### C.5 Email destination per supplier

Where each supplier's order goes is per-supplier config — needs to be set by Katie BUT we don't wait on her. Default behavior: stored in a `supplier_settings` table (single row per supplier), pre-seeded with placeholder addresses, editable via the templates settings page:

```sql
CREATE TABLE supplier_settings (
  supplier_account_id TEXT PRIMARY KEY,
  supplier_name TEXT NOT NULL,
  order_email TEXT,             -- where outbound orders go
  ppp_account_number TEXT,      -- our acct # with them
  pickup_locations JSONB,       -- [{name, address}] for the pickup dropdown
  preferred_template_id TEXT,   -- key into supplier_email_templates
  is_active BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Until Katie fills it in, the "Send" button shows a soft warning: "No order email set for Benjamin Moore yet — set it in Settings → Suppliers, or use Copy-to-Clipboard." The **Copy-to-Clipboard button works immediately** so PPP staff get value on day 1 without any waiting.

### C.6 Per-supplier email templates

Same pattern as customer templates — code defaults + DB overrides. Migration 006 adds `supplier_email_templates` (keyed by `supplier_account_id`). Default template ships in `lib/supplier-order/templates.ts`. The templates editor page gets a new section: "Per-supplier email templates" with a dropdown to pick BM / SW / etc.

---

## Phase 2D — Supplier Order Draft Modal (Thu)

Replaces the disabled "Review & Send" button on `/dashboard/materials` right detail pane.

**Layout (mobile-first):**

```
┌─────────────────────────────────────────────┐
│  Order Materials — WO #00012345 — Jane Smith │
│  ────────────────────────────────────────── │
│  [Stepper: ✓ Form Submitted → Order]         │
├─────────────────────────────────────────────┤
│  SUPPLIER                                    │
│  ◉ Benjamin Moore (5 colors)                 │
│  ○ Sherwin Williams (1 color)                │
├─────────────────────────────────────────────┤
│  FULFILLMENT                                 │
│  ◉ Deliver to customer                       │
│    Jane Smith, 123 Main St, Smithtown NY     │
│    [Edit address]                            │
│  ○ Pickup — Smithtown store (12 mi)          │
├─────────────────────────────────────────────┤
│  EXTRAS                                      │
│  ☑ 9" microfiber roller × 6                  │
│  ☑ 2" angled brush × 2                       │
│  ☐ 12oz painter's tape                       │
│  ... 17 more  [Search]                       │
├─────────────────────────────────────────────┤
│  SPECIAL INSTRUCTIONS                        │
│  [textarea, admin freeform]                  │
├─────────────────────────────────────────────┤
│  EMAIL PREVIEW (editable)                    │
│  [Big textarea showing full draft body —     │
│   admin can edit ANY line before sending]    │
├─────────────────────────────────────────────┤
│  [Copy to Clipboard]  [Send to BM] →         │
└─────────────────────────────────────────────┘
```

**Send button states:**
- Disabled while loading
- Disabled if `supplier_settings.order_email` not set → "Set BM's order email in Settings → Suppliers first"
- Enabled when ready → triggers `/api/admin/supplier-order/send`

**Idempotency**: once status=`sent`, the modal re-opens in read-only "Order #PPP-WO… sent at 10:01am" mode with options to **Mark Acknowledged** / **Mark Delivered** / **Cancel + Re-draft**.

---

## Phase 2E — Resend inbound webhook + `/dashboard/inbox` (Fri)

Per Karan: **ALL supplier replies + customer follow-ups land in the Command Center, not Gmail.**

### E.1 Resend inbound config
- Configure `orders@orders.precisionpaintingplus.net` as a Resend inbound address (dashboard setting; Katie does once)
- Resend POSTs incoming emails to `/api/webhooks/resend-inbound`
- HMAC signature verified using `RESEND_WEBHOOK_SECRET` env var

### E.2 `/api/webhooks/resend-inbound` route
- Parses sender + subject + body (text + html) + `In-Reply-To` header
- Matches to existing thread:
  1. By `Resend message_id` in `In-Reply-To` (most reliable)
  2. By PO number string in subject (`PPP-WO00012345-BM-001`)
  3. By customer email matching an active `customer_form_tokens` row
  4. If none match → goes to "Unmatched" triage bucket

### E.3 `inbox_messages` table (migration 007)

```sql
CREATE TABLE inbox_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,                  -- customer_reply / supplier_reply / unmatched
  linked_token TEXT,                   -- customer_form_tokens.token
  linked_order_id UUID,                -- supplier_orders.id
  linked_work_order_id TEXT,           -- denormalized for filtering
  from_email TEXT NOT NULL,
  from_name TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  resend_message_id TEXT UNIQUE,
  in_reply_to TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_by_user_id UUID,
  read_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ
);

CREATE INDEX inbox_messages_kind_unread_idx ON inbox_messages (kind, read_at)
  WHERE archived_at IS NULL;
CREATE INDEX inbox_messages_wo_idx ON inbox_messages (linked_work_order_id);
```

### E.4 `/dashboard/inbox` page
- **List view**: unread badges, filter tabs (All / Customer / Supplier / Unmatched), search
- **Thread view**: original outbound + every reply, threaded by message-id
- **Sidebar nav**: new entry "Inbox" with unread count chip (red dot when >0)
- **Per-WO drill-in**: from materials page, "View messages for this WO" link → filtered inbox

---

## Phase 2F — The 4 things still needing Katie's input

These DO NOT block Phase 2 from shipping with sensible defaults. They're the 5% polish:

| Q | Default until answered | Where it lives |
|---|---|---|
| BM / SW order email + format | Placeholder address + "Set in Settings → Suppliers" hint on Send button. Copy-to-Clipboard works today. | `supplier_settings.order_email` |
| PPP's account # per supplier | Email shows `[ACCOUNT #]` placeholder until set | `supplier_settings.ppp_account_number` |
| Default delivery — customer house or warehouse? | **Customer house** (per Karan's directive) | Hardcoded default, per-order override |
| Reply destination | **Command Center inbox** (locked) | Resend inbound webhook |

---

## Sequencing — daily ship plan (this week)

| Day | What ships | Hours |
|---|---|---|
| **Tue (today, done)** | Audit + scorecard UX polish (`d6de960`) + this updated plan (`674ef8b` v1, this v2 ships before exec) | 2.25h ✅ |
| **Wed** | Migration 005 + customer email/address in snapshot + `supplier_orders` table + `lib/supplier-order/builder.ts` + extras catalog + progress-bar component | 4-5h |
| **Wed** | Customer email pre-fill modal + back-fill admin page + "Mark email" UI on materials page | 1h |
| **Thu** | Supplier Order Draft Modal (full UI) + `/api/admin/supplier-order/send` + status badges on WO cards | 3-4h |
| **Thu** | Per-supplier templates + supplier settings page + the 20-item dropdown + pickup/delivery toggle | 2h |
| **Fri** | Resend inbound webhook + `inbox_messages` table + `/dashboard/inbox` page | 3-4h |
| **Fri** | Customer-form "confirm delivery address" step + drift detection if customer changes address | 1h |
| **When Katie answers** | Update supplier_settings rows (account #, order emails) + tweak format if needed | 30m |
| **Total** | **Phase 2 fully shipped** | **~14-17h this week** |

---

## Edge cases handled (the 26)

Catalog of every edge case I identified during the pre-build audit, with where each is addressed:

| # | Edge case | Handled in |
|---|---|---|
| 1 | Customer has no email in SF | A.2 — pre-fill empty + manual entry + writeback |
| 2 | Resend hard bounce | Token status `bounced` → badge "Bounced" + Resend webhook |
| 3 | Cross-device form session | Token in URL; no state |
| 4 | Customer wants to redo after submit | "Resend form" button invalidates old token, creates new |
| 5 | Admin sends form twice | Latest-token-wins in `getFormStatusByWO` |
| 6 | Customer submits partial picks | Submit endpoint skips empty colorIds |
| 7 | WO has no line items | "No rooms detailed" message |
| 8 | Order attempted before customer submits | "Wait for customer" or "Estimate from defaults" mode |
| 9 | Multiple suppliers per WO | One `supplier_orders` row per supplier; modal lets admin pick which to draft first |
| 10 | Rep changes WOLI between form submit + supplier order | Drift detection at order draft time + warning |
| 11 | PO number collision (race) | DB sequence + UNIQUE constraint |
| 12 | Resend send fails post-DB-write | status=`failed` + retry button |
| 13 | Customer email = PPP staff domain | Validation blocks `@precisionpaintingplus.*` |
| 14 | Pickup vs delivery option | C.4 — radio toggle |
| 15 | 20-item dropdown | C.3 — `supplier_extras` table |
| 16 | Multi-supplier extras | Extras attach to a specific supplier order at modal time |
| 17 | Customer is a business (Contact email, not Account) | Fallback chain: PersonEmail → Account.Email → top Contact.Email |
| 18 | Form expires mid-flow | Submit endpoint catches expiry → 410 + clean UI |
| 19 | Special chars / emoji in notes | SF text fields accept; truncate at 32k chars |
| 20 | Supplier requires PDF | Future (Phase 2.1) — Resend supports attachments |
| 21 | Required-by date in the past | Default = max(WO close date, today + 3 days) |
| 22 | PPP warehouse address not configured | env var fallback + admin warning |
| 23 | Worker double-clicks Send | Button disabled after click + DB UNIQUE constraint |
| 24 | Customer's SF address is wrong | Form "confirm delivery address" step — saved into token + flagged to admin if changed |
| 25 | Supplier reply with weird subject | Match by message-id first, PO# second, customer email third, else "unmatched" bucket |
| 26 | Stale form-status on materials page | `getFormStatusByWO` reads Supabase live (not the SF snapshot) |

---

## Definition of done

End-to-end test PPP staff can run:

1. Worker opens any open paint-job WO on `/dashboard/materials`
2. Progress bar shows: ⚪ Form Sent · ⚪ Opened · ⚪ Submitted · ⚪ Order Drafted · ⚪ Sent · ⚪ Acknowledged · ⚪ Delivered · ⚪ Complete
3. Worker clicks "Send Color Form" — email pre-fills Mrs. Smith's name + email from SF, applies the editable template, scopes the form to only her WO's WOLI rows
4. Bar advances: ✓ Form Sent (timestamp)
5. Mrs. Smith opens link → form scoped to her WO → instant color search → picks colors → confirms address → submits
6. Bar advances: ✓ Opened · ✓ Submitted (with timestamps). Colors land in SF.
7. Worker clicks "Order Materials" → draft modal opens with EVERYTHING pre-filled: customer + delivery address (from form), per-color line items + finishes + qty estimates, PPP account # with BM, PO number, required-by date.
8. Worker selects 4 items from the 20-item Extras dropdown (rollers, brushes, tape, drop cloth) — appended to email automatically
9. Worker toggles delivery mode (defaults to "to customer house"; toggles to "pickup" for rare edge cases)
10. Worker reviews the full email preview, tweaks special instructions, hits Send
11. Bar advances: ✓ Order Drafted · ✓ Sent (timestamps). Email goes to BM.
12. BM replies → reply lands in `/dashboard/inbox` (NOT Gmail). Inbox sidebar shows unread count chip.
13. Worker reads BM's confirmation in the in-app inbox, clicks "Mark Acknowledged" on the timeline
14. Bar advances: ✓ Acknowledged
15. Materials arrive at Mrs. Smith's house. Worker clicks "Mark Delivered" on the timeline
16. Bar advances: ✓ Delivered
17. Every customer-facing string (form copy, customer email, supplier email greeting/signoff) is editable from `/dashboard/settings/templates` — no deploys

**Zero retyping. No copy-pasting from Salesforce to email. Replies all in Command Center. Progress visible at a glance per WO. Done.**

---

## What I need from you to start executing

Just two things:

1. **Confirm this plan covers everything** you wanted — especially the progress bar timeline, customer email migration / pre-fill / writeback, the 20-item dropdown, the pickup/delivery toggle, and the Command Center inbox. If anything's off I'll adjust before building.

2. **The 20 items list** — you said you'd send 20 items workers might order. Once I have those I'll seed the migration with them. Until you send, I'll seed with reasonable defaults (rollers, brushes, tape, drop cloths, sandpaper, primer, putty, paint thinner, etc.) — you can edit via the Settings → Extras catalog page after.

That's it. After your green light I start with Phase 2A migration + builder. Cumulative phase 2 ship estimate: ~14-17h spread Wed-Fri.
