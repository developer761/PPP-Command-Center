# Phase 2 — Materials Ordering + Color Selection

> **Status: SHIPPED (June 2026).** Kept for historical context — this is the original plan that drove the Phase 2 implementation. For current architecture see [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md). For onboarding see [`docs/ONBOARDING.md`](./ONBOARDING.md).

**Author:** Karan + Claude · **Drafted:** May 19, 2026 · **Status (at draft time):** Plan B locked, awaiting PPP answers to §8 + Salesforce access (expected 2026-05-20)

> **2026-05-19 revision (Plan B):** The original ordering had Color Selection first, Materials Ordering second. After a CEO-perspective audit, the order flipped — **Materials Ordering ships first (Phase 2A, Week 1-3), Color Selection portal ships second (Phase 2B, Week 4+).** Reasoning is in `~/Desktop/PPP_Strategy_Notes.md` Decision 4. Short version: every job needs materials, only some jobs need a portal; rep can enter colors faster than a customer can fill out a form; lower risk if customers don't adopt; we prove the supplier integration with one supplier first. The technical sections below still apply; the *order* of work is what changed.

This document maps out the next two PPP projects after Command Center V1: an internal **Materials Ordering tool** (Phase 2A) and a customer-facing **Color Selection interface** (Phase 2B). They're treated as one phase because they share data models and the long-term flow is: customer → rep → suppliers.

---

## 1. Why this phase exists

Today the color-selection conversation happens ad-hoc — text threads, in-home consultations, a photo of paint chips on the kitchen counter. Reps then translate that into a paint order by phone or in-person at the supplier counter.

This is **slow**, **error-prone**, and **doesn't scale** as PPP grows beyond Long Island.

The replacement flow:

1. **Rep sends a link** to the customer (SMS or email) after the estimate is signed.
2. **Customer fills out a structured, mobile-first form** specifying interior/exterior, rooms, sizes, colors, finishes.
3. **PPP rep gets a notification** in the Command Center; reviews + approves selections; auto-quantity-calculator runs against Salesforce historical data.
4. **Rep clicks one button** → system sends correctly-formatted orders to the right paint suppliers (Benjamin Moore, Sherwin-Williams, Pittsburgh Paints, etc.) with exact gallons, finish, color codes, delivery address, and target date.
5. **Suppliers confirm**; PPP tracks the order status through delivery to the customer's address.

The whole loop is logged in Salesforce against the Work Order.

---

## 2. Customer flow — Color Selection

### 2.1 Entry point

- **Token-gated link** sent by rep: `hub.precisionpaintingplus.net/select/<token>`
- The token ties the selection to a specific Salesforce Work Order, so we don't ask the customer for project ID or rep name — those are inferred.
- Link sent via SMS (preferred — most homeowners react to text faster than email) or email (with same token).
- **No login required** — token is the auth.

### 2.2 Flow steps

| Step | Question | Answer type |
|---|---|---|
| 1 | Confirm name + address (pre-filled from SF) | text confirmation |
| 2 | Project type | Interior · Exterior · Both |
| 3 | (If Interior) Which rooms? | multi-select: Living Room, Bedrooms (with count), Kitchen, Dining, Bath(s), Hallway, Stairwell, Office, Other |
| 3a | For each room: dimensions OR sq ft | L × W × H inputs OR direct sq ft entry |
| 3b | For each room: walls only / walls+ceiling / ceiling only / trim / doors | multi-select |
| 3c | For each room: how many coats | 1 / 2 (default 2) / 3 |
| 3d | For each room: paint finish | Flat · Matte · Eggshell · Satin · Semi-Gloss · Gloss |
| 3e | For each room: color | curated palette OR open color picker OR "match my existing wall" (photo upload) OR "let PPP recommend" |
| 4 | (If Exterior) which surfaces? | siding · trim · doors · gutters · deck · fence |
| 4a | Exterior square footage (approx) | direct entry OR "I don't know — PPP will measure" |
| 4b | Exterior colors + finish per surface | same picker logic as interior |
| 5 | Primer needed? | Yes / No / "I don't know" (rep decides) |
| 6 | Brand preference | Benjamin Moore · Sherwin-Williams · Pittsburgh · Behr · "PPP's choice" |
| 7 | Anything else PPP should know? | free-text |
| 8 | Submit | → goes to rep |

### 2.3 UI principles

- **Mobile-first** — assume 80%+ of customers fill this out on a phone.
- **Progressive disclosure** — don't show all 50 questions at once. One section per screen with progress bar.
- **Save draft automatically** — if customer abandons mid-flow, resume from the same step when they reopen the link.
- **Visual color picking** — show actual paint swatches with brand color codes (e.g., "Benjamin Moore Simply White OC-117"). Color blindness considerations: always show the color name alongside the swatch.
- **Calculator helpers** — if customer doesn't know sq ft, offer L × W × H inputs; auto-calculate. Show the running estimate ("So far: 1,240 sq ft of wall surface").
- **Photo upload** — option to send a photo of the room or an existing color sample.
- **Send to spouse** — "I want to check with my partner before submitting" → email a snapshot of current selections.

### 2.4 Submission state

After submit:

- Customer sees a clean confirmation page: "Got it. Your selections are with [Rep Name] — they'll review and confirm within X business hours. You'll get a text when it's all set."
- Customer can re-open the same link to view/edit until rep locks the selection.
- After rep approves, the link becomes read-only — customer can still see what they chose, but edits go through the rep.

---

## 3. PPP rep workflow — Review + approve

### 3.1 New surface in Command Center

A new top-level tab in the sidebar: **"Selections"** or **"Color Submissions"**.

Lists open selections with:

- Customer name + project address
- Submission timestamp
- Status: Submitted → In Review → Approved → Ordered → Delivered
- Linked Salesforce WO
- Quick preview of total estimated paint quantity

Click into a selection → full detail view.

### 3.2 Detail view sections

1. **Customer summary** (name, address, project scope)
2. **Room-by-room breakdown** with everything they entered
3. **Quantity calculator** — automatic:
   - Standard rule: 1 gallon covers ~350-400 sq ft per coat (varies by paint type)
   - Cross-check against Salesforce historical jobs (see §5)
   - Surface as: "Estimated 14 gallons (10–18 range from 47 similar jobs)"
   - Rep can override the calculator output
4. **Per-supplier breakdown** — based on color codes, group what goes where:
   - "12 gallons Benjamin Moore (eggshell, Simply White) → BM Riverhead"
   - "4 gallons Sherwin-Williams (satin, Sea Salt) → SW Smithtown"
   - "1 gallon Pittsburgh Paints (semi-gloss, Pittsburgh White) → Pittsburgh Hauppauge"
5. **Approve & Order** button — single click to fire orders to all suppliers
6. **Notes** — internal field for rep to add context ("customer wants delivery by Tuesday")

### 3.3 Approval rules

- **No auto-send. Ever.** Every supplier email is drafted by the system but ALWAYS reviewed by a human and clicked manually. Goal: **zero supplier callbacks** because the email contains everything they need on the first send.
- **Manager sign-off above $X** — for orders over a threshold (TBD with Karan), a manager must co-approve before the reviewer's Send button activates.
- **Override mode** — reviewer can edit any field on the draft (quantities, brands, colors, delivery date, address). Edits are logged.

### 3.4 The review-and-send surface (per-supplier email approval)

This is the screen where the reviewer approves and dispatches each supplier email. **One row of orders per supplier**, each with its own review surface.

Layout:

```
┌─────────────────┬─────────────────────────┬─────────────────┐
│ CUSTOMER FORM   │ DRAFTED EMAIL           │ SUPPLIER        │
│ (what they      │ (system-generated,      │ (which supplier,│
│  submitted)     │  editable by reviewer)  │  account #,     │
│                 │                         │  cutoff time,   │
│ • Project type  │ To: orders@...          │  delivery info) │
│ • Rooms + sq ft │ Subject: PPP Order...   │                 │
│ • Finish        │                         │ Recent activity:│
│ • Color codes   │ Body: structured table  │ • last 90d $    │
│ • Brand pref    │   Qty │ Brand │ Color   │ • avg ack time  │
│ • Address       │   │ Finish │ SKU       │ • known quirks  │
│ • Notes         │ Deliver to: ...         │                 │
│                 │ PO: ...                 │ [Switch supp.]  │
│ [Photo, if any] │ [Edit] [Preview]        │                 │
└─────────────────┴─────────────────────────┴─────────────────┘
              [Send to Supplier]   [Save draft]
```

Behaviors:

- All three panels visible at once on desktop. On mobile, side-by-side collapses to a vertical stack with the customer form pinned to the top so the reviewer scrolls past it on the way to the Send button — preserves the "look at the form, then look at the email" flow.
- The drafted email body is editable; format guardrails keep the structured table intact (qty/brand/color/finish/SKU columns) so an edit can't accidentally break the parseability for the supplier.
- BCC to a PPP-owned record inbox (address TBD per Strategy Notes Q13) is automatic — reviewer never has to remember.
- "Send to Supplier" requires an explicit confirmation modal to prevent accidental dispatches.
- "Save draft" persists edits if the reviewer steps away; the draft loads back exactly as left.
- "Switch supplier" reroutes to a different supplier — useful if the suggested one is out of stock, past the cutoff, or doesn't carry a color.
- After send, the order moves to `sent`. The reviewer's user_id is recorded as the sender for audit trail.

### 3.4.1 Multi-supplier orders + Send-all-approved shortcut

A single customer order can fan out to multiple suppliers (Benjamin Moore items go to BM, Sherwin-Williams items go to SW, etc.). The order form has a **per-line-item supplier dropdown** — each row's "Order from" defaults to the supplier that carries that brand, and the worker can override per line.

When the worker clicks "Generate Drafts," the system groups line items by supplier and creates one email draft per supplier. The reviewer sees a tabbed or stacked view with all the drafts:

```
┌──────────────────────────────────────────────────────────────┐
│ Drafts ready for review (3)                                  │
│ ☐ Approved   [BM Riverhead]      [Sherwin Smithtown]   [PPG] │
├──────────────────────────────────────────────────────────────┤
│  ← Side-by-side review surface (customer form │ email │ supp)│
│                                                              │
│           [Send to Supplier]  [Save draft]                   │
└──────────────────────────────────────────────────────────────┘
                                          [Send all approved (0)]
```

Behaviors:

- Each draft has its own **"Approved" checkbox** at the top.
- Each draft also has its own **"Send to Supplier"** button for individual sends.
- A **"Send all approved (N)"** button at the bottom dispatches every draft currently marked approved in one shot. Counter updates live as boxes are checked.
- Default workflow is one-at-a-time review + send. "Send all approved" is a power-user shortcut for after the reviewer has eyeballed all drafts and they look clean.
- The confirmation modal on "Send all approved" lists which suppliers are about to receive emails ("You're about to send 3 emails: BM Riverhead, Sherwin Smithtown, PPG. Confirm?") to prevent accidents.
- Sending one draft doesn't lock the others — they stay editable until each is sent.

### 3.4.2 Order entry fields (the worker's input form)

When the worker creates a new order, they fill in:

- **Salesforce WO link** (optional) — if linked, customer details pre-fill from SF; if not, worker enters customer info manually.
- **Customer name + address** (auto-filled from SF if linked, else manual entry).
- **Project type** — Interior / Exterior / Both.
- **Interior/exterior breakdown** — passes through to the email so suppliers know what to expect.
- **Line items** (one row per paint type):
  - Brand (Benjamin Moore / Sherwin-Williams / Pittsburgh / Behr / Other)
  - Color name + code
  - Finish (Flat / Matte / Eggshell / Satin / Semi-Gloss / Gloss)
  - Gallons
  - Room or surface ("Living Room walls," "Front exterior," etc.)
  - **Order from** dropdown (which supplier branch — defaults based on brand)
- **"Need delivered by" date** — single date picker for the whole order. Defaults to 7 days from today. Worker can change before drafting. Flows into every supplier email as the target delivery date.
- **Internal notes** — free-text field for the worker (e.g., "customer prefers morning delivery") that does NOT go into supplier emails by default but can be pulled in if the worker chooses.

The "When does Generate Drafts unlock" rule: required fields are customer name, address, at least one line item, and the delivery date.

### 3.5 Edge cases — review-and-send loop

1. **Two reviewers open the same order** — claim/lock when opened; show "Currently reviewed by [Name]" to others. Auto-release the lock after 15 min idle.
2. **Customer form missing info** (no sq ft, no finish) — red flag at the top of the form column; block Send until filled in OR reviewer explicitly clicks "send anyway" with a reason.
3. **Reviewer edits gallons** — recalculate total cost preview live; warn if it crosses the budget threshold.
4. **Reviewer changes the color code by hand** — verify against the supplier's catalog; warn if unrecognized.
5. **Email send fails** (SMTP error, supplier mailbox full) — order stays `pending`, surface failure reason, reviewer can retry. Never silently lose an order.
6. **Supplier replies "we can't fulfill"** — reply lands back in the same thread in Command Center; alert the original reviewer; auto-switch-supplier flow available.
7. **Duplicate order check** — before showing a draft, dedupe against (WO_id + supplier + color + qty + 24h window).
8. **Reviewer A edits, reviewer B sends** — audit log captures both + the diff.
9. **Customer changes selection after draft but before send** — refresh the draft against new selection. If draft was already sent, lock and create a follow-up order for the diff.
10. **Reviewer is OOO and order is urgent** — backup user can claim the lock and take over without losing draft state.
11. **No bulk approval, ever** — explicitly NOT a feature. Each email gets individual review. Karan's hard rule.

This is the floor, not the ceiling: if later we add high-confidence pre-fills (so reviewers mostly click Send after a glance), it's still human-in-the-loop — never silent dispatch.

---

## 4. Materials Ordering — automated supplier dispatch

### 4.1 Order generation

For each supplier, the system builds an email like:

```
To: orders@bmriverhead.com
Subject: PPP Materials Order — WO-12345 — Patel Residence

Hi team,

Please prepare the following for delivery on Tuesday, May 26:

Quantity   Brand    Color                     Finish      SKU
12 gal     BM       Simply White OC-117       Eggshell    BM-23-OC117-E
4 gal      BM       Hale Navy HC-154          Semi-Gloss  BM-23-HC154-SG
2 gal      BM       White Dove OC-17 (Primer) Flat        BM-PRM-OC17-F

Deliver to:
  Patel Residence
  123 Main St, Huntington, NY 11743
  Contact: 631-555-0143

PO Reference: WO-12345
Account: Precision Painting Plus (Acct #PPP-RHD-001)

Please confirm receipt and expected delivery time.

— Order Bot, Precision Painting Plus
  (forwarded to Karan @ orders@precisionpaintingplus.net for record)
```

The format is **per-supplier customizable** — each supplier in the system has a template with their preferred fields, account number, email address, and any quirks (e.g., one supplier requires PO format `PPP-YYYY-NNNN`).

### 4.2 Supplier configuration

New Supabase table: `suppliers`

| Field | Example |
|---|---|
| `id` | uuid |
| `name` | "Benjamin Moore — Riverhead" |
| `brand` | "Benjamin Moore" |
| `order_email` | orders@bmriverhead.com |
| `order_phone` | 631-555-0177 |
| `account_number` | PPP-RHD-001 |
| `delivery_cutoff_local` | "14:00" (orders after 2 PM ship next business day) |
| `min_order_qty` | 1 (gallon) |
| `template_id` | reference to a per-supplier order template |
| `payment_terms` | "Net 30" or "Credit card on file" |
| `pickup_addr` | optional — pickup at counter |
| `ship_zip_radius_miles` | 50 |

### 4.3 Delivery method options

- **Email** (default) — supplier receives a formatted order
- **SMS** (some smaller suppliers prefer text) — uses Twilio
- **Phone call dispatch** (last resort) — system drafts the order, surfaces a "Call them" button with prefilled text for the rep to dictate

We do **NOT** scrape supplier websites — too brittle and likely against ToS. We work with suppliers via their preferred order channel.

### 4.4 Order status tracking

For each order, track:

| Status | Meaning |
|---|---|
| `pending` | drafted but not yet sent |
| `sent` | email/SMS dispatched |
| `acknowledged` | supplier replied confirming receipt |
| `shipped` | supplier confirmed shipment |
| `delivered` | confirmed delivered to address |
| `cancelled` | rep cancelled before shipment |
| `exception` | something went wrong (price mismatch, out of stock, etc.) |

Status updates come via:
- **Email parsing** of supplier replies (Anthropic extraction)
- **Manual updates** by the rep in Command Center
- **Future:** if suppliers offer an API or webhook, integrate

### 4.5 Cost tracking

Each order line item has an expected price (from the supplier's last-known pricing). When the actual invoice arrives:

- Compare to expected
- If within tolerance (e.g., ±5%), auto-record the Transaction in SF (this is the bridge to Phase 3 receipts automation — Materials Ordering writes the "expected receipt" row that Phase 3 closes)
- If outside tolerance, flag for review

---

## 5. Salesforce historical lookup — quantity estimation

**Why:** the customer says "paint my 12 × 14 ft bedroom with two coats of eggshell." The math says 5.3 gallons. But for paint-business reality, what does *PPP* actually use for similar jobs? Answer this from history.

### 5.1 Query approach

For each new selection, query SF for:

- Closed Won Work Orders
- Same service line (Residential / Commercial)
- Similar customer footprint (sq ft range, room count)
- Last ~12-24 months

Then compute:

- Median gallons per sq ft per coat
- Min/max range
- Per-brand if relevant (BM coverage differs from SW)

Surface in the Command Center as: **"Estimated 14 gallons (range 10–18 across 47 similar past jobs)."**

This gives the rep a sanity check on the math. If the calculator says 20 gallons but the historical range is 10–18, flag for review.

### 5.2 Edge cases for the lookup

- **No historical data** (brand-new market, new service line) → fall back to standard coverage rules
- **Outlier jobs** (one job used 30 gallons for a small bedroom due to dark-on-light coverage) → exclude using IQR filter
- **Color matters** — going from dark to light needs more coats; light to dark needs fewer. Show historical comparable per direction.
- **Multi-region variance** — Suffolk humidity may affect coverage differently than Brooklyn — segment by region when sample size allows

---

## 6. Edge cases — comprehensive

### 6.1 Customer-side

1. **Customer abandons mid-flow** → save draft, send a reminder text after 24h
2. **Customer opens link from a different browser** → resume from saved state via token + cookie
3. **Customer doesn't know their address** → Google Maps autocomplete; default to SF-stored project address
4. **Customer wants colors PPP painted next door** → lookup nearby past jobs (with customer-privacy guard) and offer to match
5. **Indecisive customer** → "Help me pick" mode that narrows by preference (warm/cool, light/dark, traditional/modern)
6. **Customer changes selections after rep approves** → lock UI; surface a "Request a change" button that pings the rep instead
7. **Multiple decision-makers** (spouse, parent, designer) → "Send to my spouse for review" email button before final submit
8. **Customer wants a consultation first** → "Schedule a call instead" CTA fires a calendar link
9. **Color picker on mobile is annoying** — use full-screen swatch grid with one-tap selection, not tiny color sliders
10. **Spanish-language customer** → toggle for Spanish (NY market has large Spanish-speaking population — worth doing on launch, not later)
11. **Customer color preferences not in any supplier catalog** → flag to rep ("custom tint needed — confirm with supplier")
12. **Customer doesn't know what "finish" means** → tooltips with one-line explanations (Flat = no shine, Satin = soft sheen, etc.) + visual examples
13. **Customer wants free test patches before committing** → "Order sample only" mode that ships 4oz testers instead of gallons

### 6.2 PPP rep side

1. **Notification overload** if 10 selections come in same morning → batch in a Slack channel or daily digest
2. **Rep wants to override customer choices** (wrong finish for high-moisture kitchen) → versioned: rep's override is logged with reason
3. **Rep is OOO** → auto-assign to backup based on the WO's primary owner
4. **Additional materials not in customer flow** (caulk, primer, tape, drop cloths, brushes) → "Add internal line items" section before ordering
5. **Approval workflow for big orders** — over $X requires manager sign-off; system blocks Order button until approved
6. **Job cancellation mid-order** — ability to cancel orders before delivery; restocking fees flagged

### 6.3 Materials ordering / supplier integration

1. **Color not in stock at preferred supplier** → fall back to next supplier; surface the swap to the rep
2. **Supplier closed (weekend / holiday)** → queue order; send next business day; warn rep about delay
3. **Order email bounces** → alert rep with the bounce reason; offer fallback to phone/SMS
4. **Price changed at supplier** → recalculate total; warn if it exceeds budget by >5%
5. **Partial delivery** (some colors ship, some backordered) → reconcile against expected; track outstanding
6. **Wrong delivery address** → editable until "shipped" status
7. **Supplier doesn't ship to that ZIP** → reroute to nearest supplier OR PPP pickup
8. **Duplicate orders** for same WO → dedupe by (WO_id + supplier + color + qty + 24h window)
9. **Tax/shipping** varies by supplier → preview total before sending; rep confirms
10. **Multi-job-site customer** (property manager with 5 buildings) → keep orders separate per address
11. **Color match across suppliers** — BM "Simply White" ≠ SW "Pure White"; force one supplier per color where possible
12. **Custom tint orders** — most paint is tinted from a base; verify tint code is correct before sending

### 6.4 Data / privacy / SF

1. **Customer data is PII** (address, phone, color selections tied to home address) — encrypt at rest in Supabase; respect PPP's data retention policy
2. **SF write permissions** — service account must have create-on-WO permission; read-only fallback for safety
3. **Audit trail** — log every action: who submitted, who approved, who ordered, who modified
4. **Token expiration** — selection links expire after 30 days; rep can regenerate
5. **Token sharing** — anyone with the link can fill it out; flag if same token submits from multiple IPs
6. **SF API rate limits** — cache historical-job lookups; don't query on every keystroke

### 6.5 Phase 3 bridge

Materials Ordering writes an `expected_receipt` record for each order. When Phase 3 receipts automation processes the actual receipt from the supplier:

- Match on (vendor + amount + WO_id + date)
- Mark the `expected_receipt` as `received` if amount matches within tolerance
- Variance > tolerance → exception queue for review

This makes Phase 3 dramatically more accurate than parsing receipt emails cold.

---

## 7. Tech stack

Same as Command Center V1:

- **Next.js 16 + React 19** — App Router, Turbopack
- **Tailwind 4** — brand-aligned styling via existing `@theme` tokens
- **Supabase** — Postgres + Realtime (for status updates pushing to Command Center)
- **Anthropic SDK** — color name normalization, supplier-email composition, edge-case flagging, supplier reply parsing
- **Resend** — outbound emails to customers + suppliers
- **Twilio** — outbound SMS to customers + suppliers (some prefer SMS)
- **Salesforce REST API** — read historical jobs; write Transaction records
- **Vercel** — same project, same domain (`hub.precisionpaintingplus.net/select/<token>`)

### 7.1 Suggested database schema (new tables on existing Supabase)

```sql
-- Color Selection submissions
create table color_selections (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,                     -- URL token, ungues sable
  sf_wo_id text not null,                          -- Salesforce Work Order ref
  customer_name text not null,
  customer_phone text not null,
  customer_email text,
  project_address text not null,
  project_type text not null check (project_type in ('interior', 'exterior', 'both')),
  status text not null default 'draft' check (
    status in ('draft', 'submitted', 'in_review', 'approved', 'ordered', 'delivered', 'cancelled')
  ),
  brand_preference text,                           -- preferred supplier brand
  notes_from_customer text,
  notes_from_rep text,
  approved_by_user_id uuid,                        -- which PPP user approved
  approved_at timestamptz,
  link_sent_at timestamptz default now(),
  link_expires_at timestamptz default (now() + interval '30 days'),
  submitted_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Per-room/surface line items inside a selection
create table selection_rooms (
  id uuid primary key default gen_random_uuid(),
  selection_id uuid not null references color_selections(id) on delete cascade,
  surface_type text not null,                      -- 'walls', 'ceiling', 'trim', 'doors', 'siding', etc.
  room_name text,                                  -- 'Living Room', 'Bedroom 1', 'Front exterior', etc.
  sq_ft numeric,
  dimensions_l numeric,
  dimensions_w numeric,
  dimensions_h numeric,
  coats int not null default 2,
  finish text not null,                            -- 'flat', 'matte', 'eggshell', 'satin', 'semi-gloss', 'gloss'
  color_code text,                                 -- brand code (e.g., 'OC-117')
  color_name text,                                 -- human name (e.g., 'Simply White')
  color_brand text,                                -- 'Benjamin Moore', 'Sherwin-Williams', etc.
  color_hex text,                                  -- approximate hex for UI display
  photo_url text,                                  -- optional: photo for "match my existing wall"
  notes text
);

-- Suppliers
create table suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  brand text not null,
  order_email text,
  order_phone text,
  account_number text,
  delivery_cutoff_local text,                      -- e.g., '14:00'
  min_order_qty int default 1,
  payment_terms text,
  ship_zip_radius_miles int default 50,
  template_name text                               -- which email template to use
);

-- Materials Orders dispatched to suppliers
create table materials_orders (
  id uuid primary key default gen_random_uuid(),
  selection_id uuid not null references color_selections(id),
  supplier_id uuid not null references suppliers(id),
  sf_wo_id text not null,                          -- denormalized for audit
  status text not null default 'pending' check (
    status in ('pending', 'sent', 'acknowledged', 'shipped', 'delivered', 'cancelled', 'exception')
  ),
  total_expected_cents int,                        -- expected total in cents
  total_actual_cents int,                          -- filled from actual invoice
  delivery_address text not null,
  delivery_target_date date,
  sent_at timestamptz,
  acknowledged_at timestamptz,
  delivered_at timestamptz,
  notes text,
  created_at timestamptz default now()
);

-- Per-line-item inside a materials order
create table materials_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references materials_orders(id) on delete cascade,
  sku text,
  color_name text,
  color_brand text,
  color_code text,
  finish text not null,
  gallons numeric not null,
  expected_unit_price_cents int,
  expected_total_cents int
);

-- Expected receipts — written when an order is dispatched; matched by Phase 3
create table expected_receipts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references materials_orders(id) on delete cascade,
  sf_wo_id text not null,
  supplier_id uuid not null references suppliers(id),
  expected_vendor text not null,
  expected_amount_cents int not null,
  expected_date_window_start date not null,
  expected_date_window_end date not null,
  status text not null default 'open' check (status in ('open', 'matched', 'variance', 'cancelled')),
  matched_at timestamptz,
  matched_receipt_id uuid,                         -- foreign key set by Phase 3
  variance_cents int                                -- positive = over budget
);
```

### 7.2 New routes

| Route | Purpose | Auth |
|---|---|---|
| `/select/[token]` | Public customer-facing selection form | token in URL |
| `/select/[token]/preview` | Read-only confirmation page | token in URL |
| `/dashboard/selections` | List of all open selections (PPP team) | Google SSO |
| `/dashboard/selections/[id]` | Detail + approve + order page | Google SSO |
| `/dashboard/suppliers` | Supplier configuration | Google SSO + admin |
| `/api/select/[token]` | Save customer-side selection drafts | token |
| `/api/select/[token]/submit` | Submit finalized selection | token |
| `/api/selections/[id]/approve` | Rep approves a selection | session |
| `/api/selections/[id]/order` | Fire the materials orders | session |
| `/api/orders/[id]/status` | Update order status | session or webhook |

---

## 8. Open questions for PPP (need answers before build)

Reordered for Plan B — Materials Ordering critical questions first; Color Selection portal questions deferred.

### Critical — need before Phase 2A Week 1

1. **List the actual paint suppliers PPP uses today.** Name, location (which branch), brand. Probably 4 of them — confirm exact count and pick the #1 to start with.
2. **For each supplier: what's the current ordering process?** Email to a generic inbox? Text/call to a dedicated account rep? Online B2B portal? Phone? Each is a different design.
3. **For each supplier: who's PPP's dedicated account rep?** Name + email + phone. (We'll route orders through them, not generic inboxes, because they know PPP's job patterns.)
4. **Account numbers + PO format** with each supplier.
5. **Payment terms with each supplier** — Net 30? Credit card on file? Account billing? COD?
6. **Tax-exempt status** — does PPP have reseller certificates on file with each supplier?
7. **Delivery vs pickup** — direct to customer site, to a PPP warehouse, or pickup at the supplier counter?
8. **Daily / weekly order volume** — how many materials orders per week on average? (Sizes the reviewer's bandwidth.)
9. **Who at PPP becomes the order reviewer?** Office Ops? A specific rep? Manager? (Affects the workflow + bandwidth.)
10. **Approval threshold for manager sign-off** — what dollar amount triggers a second pair of eyes?
11. **Does Salesforce track gallons per job?** Or is that data only in invoices/receipts? Affects whether the quantity-estimator has a real historical source.
12. **What's the #1 thing that goes wrong with materials orders today?** Wrong color delivered? Wrong quantity? Late delivery? Supplier billing errors? — tells us what to design *against*.

### Deferred — need before Phase 2B (Color Selection portal, Week 4+)

13. **% of jobs where customers know colors at estimate signing** vs need to decide afterward — sizes the audience for the customer portal.
14. **Curated colors vs full catalog** — does PPP have a "house palette" we should default to, or do we show the entire BM/SW/PPG catalog?
15. **Mobile vs desktop split** for customers — affects design priority but not feasibility.
16. **Spanish-language need** — should the portal launch with English + Spanish given the NY market?
17. **How does PPP currently capture color decisions?** Text photos? Written on the estimate? Customer comes to the office?
18. **Multi-job customers** (property managers, repeat customers) — reusable selections across projects?

---

## 9. Build sequencing (Plan B)

Rough order of work, once the §8 questions are answered + Salesforce sandbox is live:

### Phase 2A — Materials Ordering (Weeks 1-3)

**Week 1 — Foundation + one supplier end-to-end**
- Supabase schema: `materials_orders`, `materials_order_items`, `suppliers`, `expected_receipts` (color_selections + selection_rooms can wait for 2B)
- `/dashboard/selections/new` form in Command Center where rep enters: customer + WO + rooms + colors + finish + brand + delivery date
- Hardcode ONE supplier (the most-used one PPP names in §8 Q1) — full email template, account number, payment terms, delivery info
- The side-by-side review surface from §3.4 — customer-form-equivalent (= rep's entered data) + drafted email + supplier panel
- "Send to Supplier" via Resend, with `orders@precisionpaintingplus.net` BCC
- Get PPP reps actually using this for 1-2 real orders by end of Week 1

**Week 2 — Multi-supplier + status tracking**
- Add the remaining 3 suppliers from §8 — each with their own template + account # + cutoff time
- Per-supplier brand-color catalog (basic — supplier-specific color codes verified at draft time)
- Order status lifecycle (pending → sent → acknowledged → shipped → delivered) with manual status updates in Command Center
- Salesforce write: create a "Materials Order" record linked to the WO (read-only SF first, write second)
- Expected receipts table populated when orders are sent (the Phase 3 bridge)

**Week 3 — Edge cases + production cutover**
- All edge cases in §6.2 + §6.3 + §3.5 (claim/lock on simultaneous reviewers, missing-field flags, duplicate-order dedup, send-failure retry, supplier-reply parsing)
- Quantity-estimator with Salesforce historical lookup (if SF tracks gallons — TBD per §8 Q11)
- Manager-approval threshold (TBD per §8 Q10)
- Soft launch with one paint rep doing all orders through the tool for one week; iterate based on what breaks

### Phase 2B — Color Selection portal (Weeks 4-6)

Only starts once Materials Ordering is in daily use and PPP is asking for the customer portal upgrade.

**Week 4 — Customer-facing shell**
- Supabase schema: `color_selections` + `selection_rooms` (now we add them)
- `/select/[token]` route with token-gated entry
- Form steps (project type, rooms, dimensions, finish, color, brand pref, notes)
- Draft autosave + resume
- Mobile-first responsive design

**Week 5 — Color picker + handoff**
- Visual color picker with brand-specific swatches (curated subset per §8 Q14)
- Customer submission → notification to rep
- Rep can pull a customer-portal selection into the same `/dashboard/selections/new` form they use for manual entry — same downstream flow, two input paths
- Spanish-language toggle (per §8 Q16)

**Week 6 — Polish + edge cases + cutover**
- Walk through §6.1 edge cases (multi-decision-makers, indecisive customer modes, photo upload, send-to-spouse)
- Soft launch with a few selected customers
- Iterate

**Honest estimate: 6 weeks total for both phases.** Phase 2A is the priority and ships at week 3 standalone. Phase 2B is an enhancement layered on top — could be deferred past week 6 if other priorities emerge.

---

## 10. Success metrics

How we'll know it's working:

- **Time-to-order** drops from "1-2 days after color discussion" to "minutes after customer submits"
- **Order accuracy** — % of orders that ship without a correction → target 95%+
- **Customer satisfaction** — survey post-completion: "How was the color selection process?" → target 4.5/5
- **Rep time saved** — minutes per WO before vs after → target 30+ min saved per WO
- **Supplier acknowledgment time** — average lag between PPP order email and supplier ack → target <2 hours during business hours

---

## 11. What we are NOT building in Phase 2

To keep scope honest:

- ❌ Customer login / account creation — token links are the auth
- ❌ Payment processing — orders go to suppliers PPP already has accounts with
- ❌ Inventory management — we don't track what PPP has in their warehouse (that's the painter's job)
- ❌ Scheduling crew assignments — that's the Coordination AI Agent (Phase 5)
- ❌ Review requests — that's the Reviews/Post-WO AI Agent (Phase 7)

---

## Next steps

1. **Karan reviews this doc** and answers the questions in §8
2. **Confirm with Alex** — anything to add from his side
3. **Walk it through with Alex / Katie** for paint-business reality check (do the suppliers really work this way? Are the order formats right?)
4. **Lock scope** for Phase 2 — decide what's MVP vs nice-to-have
5. **Begin Week 1 build** once Salesforce sandbox access lands (we can build the customer flow without SF, but the rep flow + quantity calc needs SF history)

— Ready for Karan's review.
