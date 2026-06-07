# Architecture

The deeper companion to the top-level [README](../README.md). Read the README
first for the orientation + folder map; this doc covers the non-obvious
mechanics a future dev will hit when changing the code.

---

## Why these choices

### Salesforce as system of record (not Supabase)

PPP already runs their business in Salesforce — accounts, work orders, line
items, finished orders all live there. Mirroring SF into Supabase would
create a two-source-of-truth problem: every dashboard surface would have
to choose which source to trust, and any drift would silently corrupt the
"current state" displays.

So Command Center **reads** SF live (with a 30-min cache) and **writes back**
final state when admins finish a workflow (color picks, material type,
vendor orders). Supabase exists only for the things SF can't model cleanly:
draft state during a workflow, sent-email logs with delivery status, audit
trails for replay, and the customer-form token system.

### The snapshot pattern (`lib/salesforce/queries.ts`)

A naive "fetch SF data when the page asks for it" architecture would be
unusably slow — every page navigation would trigger ~30 SOQL round-trips.
Instead:

1. **One fat `loadSalesforceSnapshot()` call** pulls everything the dashboard
   needs (opps + WOs + line items + accounts + paint colors + reps + ...) in
   parallel where the dependency graph allows.
2. **In-memory cache (per Vercel instance), 30-min TTL** — second caller on
   the same instance gets the cached object back instantly.
3. **Promise dedupe** — concurrent cold callers share one in-flight request
   rather than racing.
4. **Cross-instance shared cache (Supabase `snapshot_cache`)** — when one
   instance builds a fresh snapshot it writes a gzipped blob; other cold
   instances read the blob (~200-500ms) instead of re-running every SOQL.
5. **Generation counter** — a single int in Supabase. Bumps on writeback
   (customer form submit) or manual refresh. Each instance polls (max once
   per 5s) so cross-instance invalidation lands in seconds, not minutes.

### Thin snapshot for the materials page

The full snapshot is dominated by the ~89k Opportunity records (PPP's full
sales history, paginated SF query, ~6-10s cold). The materials page only
consumes `{workOrders, woLineItems, accounts, paintColors}` — it doesn't
care about opportunities, quotes, leadStats, etc.

So `loadSalesforceSnapshot({thin: true})` skips the opp fetch + 6 other
secondary queries and returns a snapshot with empty arrays for the unused
fields. Cached under `snapshot-thin-v1` so the dashboard's full snapshot
isn't poisoned. Materials page cold load went from ~8-15s to ~2-4s.

If you build a new page that only needs WO/Account/PaintColor data,
opt into thin mode via `loadDashboardData(sp, { thin: true })`.

---

## Customer color form deep-dive

The single most-touched user flow. Three actors:

1. **Admin** (PPP staff) — sends the form
2. **Customer** (homeowner) — picks colors, submits
3. **Supplier** (Aboffs, Willis, etc.) — receives the resulting paint order

### Token system (`customer_form_tokens` table)

Every "Send Color Form" + every "Preview" click creates a token row. The
token is the URL the customer (or admin in preview) clicks: `/select/<token>`.

```
customer_form_tokens
├── token              TEXT PRIMARY KEY           — random URL-safe id
├── work_order_id      TEXT NOT NULL              — SF WorkOrder.Id (15- or 18-char)
├── work_order_number  TEXT                       — denormalized for display + audit
├── customer_email     TEXT NOT NULL              — where the email went
├── customer_name      TEXT                       — denormalized from Account.Name
├── created_by_user_id UUID → auth.users          — which admin sent it
├── kind               TEXT                       — NULL=real send, 'preview'=admin QA
├── created_at, sent_at, opened_at, submitted_at, expires_at
├── submitted_payload  JSONB                      — full form payload
├── delivery_status    TEXT                       — delivered/bounced/spam (Resend webhook)
└── resend_message_id_invite                      — for re-firing bounces
```

### Preview vs real send — DO NOT BREAK THIS

A `kind='preview'` token exists so admins can open the customer form in a
new tab without sending an email. The preview path:

- **Doesn't** send a Resend email (no `markSent` call)
- **Doesn't** count toward Mail Hub sent stats
- **Doesn't** stamp opened_at on a real customer's record
- **Does** create a real token row + render the form normally
- **Does** allow the form to be "submitted" but the submit is a no-op
  (no SF writeback, no notify, no `submitted_at` stamp)

**Five surfaces filter out `kind='preview'`:**

| Surface | File | Why |
|---|---|---|
| Materials page progress timeline + form status | `lib/materials-page-data.ts` | The JobDetail panel was the bug Karan caught — Preview click stamped "Customer Opened" |
| Standalone progress builder | `lib/wo-progress/derive.ts` | Same risk on any future page that uses this builder |
| Form status helper | `lib/customer-form/wo-status.ts` | Used by Mail Hub + others |
| Activity feed (home dashboard) | `app/api/admin/activity/route.ts` | Would show "Customer opened color form" lies |
| Per-customer mail timeline | `app/api/admin/customer/[accountId]/route.ts` | Same — false customer-activity events |

**If you add another surface that reads `customer_form_tokens`, you MUST
filter `kind='preview'`.** The filter is done in the loop (not the
PostgREST `.or()` query) because PostgREST's `.or()` only allows one filter
chain — chaining two `.or()` calls overwrites the first.

### Notes-only path (sparse / exterior WOs)

Many SF WOs have zero detailed line items — typical for exterior jobs where
the worker only puts a project description into the WO's `Description`
field. Those WOs would land on a dead-end form ("here are zero rooms to
pick colors for") without special handling.

The notes-only path:

1. `lib/customer-form/render-data.ts` includes `WorkOrder.Description` and
   `WorkOrder.Subject` in the rich SELECT (with graceful narrow-SELECT
   fallback when the org doesn't have those fields).
2. `components/customer-form-view.tsx` detects `lineItems.length === 0`
   and renders a "Project context" card (showing the SF Description) + a
   primary "Describe what you'd like painted" textarea. Copy tunes to
   interior / exterior / both via the helpers in `lib/customer-form/material-types.ts`.
3. Submit button is enabled when `hasLineItems || globalNotes.trim().length > 0`
   (you can submit with notes even if there are no rooms).
4. The submit route (`app/api/customer-form/submit/[token]/route.ts`) treats
   `attempts.length === 0 && notesOnly === true` as "meaningful submission"
   for the admin-notification path, with copy that says "project notes"
   instead of "colors" so admin's expectation matches reality.
5. The admin notify email (`lib/customer-form/notify-sender.ts`) carries
   the `notesOnly` flag to drive the noun/verb copy.

### Material Type picker (~100-product dynamic catalog)

`lib/customer-form/material-types.ts` is the single source of truth for
every paint product line. Each product is tagged:

```ts
type MaterialTypeCategory = "interior" | "exterior" | "any";
```

Three consumers read this catalog:

| Consumer | What it shows |
|---|---|
| `components/customer-form-view.tsx` | Job-level picker the customer sees |
| `components/supplier-order-modal.tsx` | Admin's per-color override dropdown (compact mode) |
| Server-side validators in `app/api/customer-form/submit/[token]/route.ts` + `app/api/admin/supplier-order/send/route.ts` | Reject unknown values |

`filterMaterialTypesForWorkOrder(context)` is the routing function:

- Interior-only WO → interior + any products
- Exterior-only WO → exterior + any products
- Mixed/unknown WO → all products

Heuristic for interior/exterior detection (`isInteriorWorkOrder` +
`isExteriorWorkOrder`): case-insensitive regex on `WorkType.Name` +
line-item product names. Robust to nulls; safe default is "show everything."

### Writeback safety mode (`lib/customer-form/writeback-mode.ts`)

During the test phase PPP wants color picks to flow back to Salesforce —
but only for specific test WOs, not production WOs. Three modes:

- `mode='test_only'` (default) — write back only if the WO is in
  `customer_form_writeback_allowlist`
- `mode='all'` — production rollout, every submission writes back
- `mode='off'` — kill switch

`decideWriteback(woId)` is the gate. Submit route calls it before
`writeSfBatch()`. When the gate blocks the write, the submitted payload is
still saved in `customer_form_tokens.submitted_payload` — nothing is lost,
admin can replay later via `sf_writes_audit`. The notify-sender email
includes a blue "Saved to Command Center only" banner so admin knows SF
wasn't updated.

---

## Supplier order deep-dive

### Builder pattern (`lib/supplier-order/builder.ts`)

`buildSupplierOrderDraft(input)` is the single function that composes a
draft supplier order. It accepts a WO + supplier + customer-submitted
payload + admin overrides, and returns the full email-ready draft:

- `subject` — `"Paint Order — <PO#> — <Customer Name>"`
- `body` — the plain-text body the supplier sees (no HTML — text-only
  emails so customer notes can't inject scripts)
- `lineItems` — paint colors with brand × name × code × gallon estimate
- `extras` — non-paint items (rollers, tape, etc.) with qty/unit
- `recommendedFinishStrategy` — single-MT header vs mixed per-line
- `unresolvedAddress` — true when fulfillment=delivery but no usable address

The builder is intentionally pure (no SF/Supabase IO) — it takes a fully
loaded context as input and produces a deterministic draft. Easy to test
manually, easy to call from multiple routes (`/draft`, `/send`, audit replay).

### Material Type resolution

```
Per-color override (admin set in modal)
  → customer's job-level Material Type pick (submitted_payload.materialType)
  → WO's pre-set MaterialType__c (admin's pre-fill before the form went out)
  → null (triggers "⚠ Paint product line not specified" warning in email)
```

This three-tier fallback is in `formatOrderSummaryBlock`. The chain was
broken until 2026-06-07 — the WO fallback link was unreachable due to a
`"" ||` typo. Audit pass caught it; now the WO pre-set value is honored.

### PO number format

`PPP-WO00284666` for the first send. Collisions get suffixed: `-2`, `-3`,
etc. Cancelled orders are excluded from the collision counter (retracting
a draft doesn't bump the next live PO).

Why the format change (from `PPP-WO00284666-ABO-000123`): Katie 2026-06-05
asked to drop the supplier-code segment — vendors don't need it, and the
simpler format is easier to reference in phone calls.

### Resend inbound matching

When a supplier replies to a PPP order, Resend forwards the email to
`/api/webhooks/resend-inbound`. The webhook extracts the PO number from
the subject/body via regex (`/PPP-WO[A-Z0-9]+(?:-[A-Z]+-\d+)?(?:-\d+)?/i`)
and threads the reply to the correct supplier_order + WO in Mail Hub.

The regex matches BOTH the old `PPP-WO00284666-ABO-000123` format AND the
new `PPP-WO00284666[-2]` format — important because in-flight orders from
before the format change still need to thread correctly.

---

## Auth model

- **Admin routes** (`app/api/admin/*`) require Supabase auth + `is_admin=true`
  in the `profiles` table. Gate is checked at the route handler level.
- **Customer form submit** (`/api/customer-form/submit/[token]`) is public
  but token-gated — the route validates the token against
  `customer_form_tokens` (not expired, not submitted, matches `/select/[token]`).
- **Webhooks** (Resend events + inbound) verify Svix signatures using
  shared secrets in env.
- **Service-role Supabase client** is server-only (`lib/supabase/server.ts`).
  Never import it into a client component — it would leak the service key
  to the browser bundle.

### Viewer scoping (`lib/auth/scope-snapshot.ts`)

When a worker (non-admin) loads the dashboard, the snapshot is filtered to
just their own opportunities + work orders + accounts. Admins see everything.

The scoping is done by joining `auth.users.id` → SF user id (via the
`sf_user_id` column on `profiles`) → owner-id filter on snapshot data.
"View as" simulates a different rep for admin diagnostics.

---

## Performance notes (the things that aren't obvious)

1. **Snapshot cache is the page-load bottleneck on cold instances.** Warm
   loads are instant; cold loads hit Salesforce. The pre-warm cron
   (`/api/cron/snapshot-warm`) fires every 10 min to keep the shared
   Supabase cache fresh so cold instances skip the live SF query.
2. **Modal lazy-loading** matters. SupplierPickerModal, SupplierOrderModal,
   DraftOrderModal, WoPastOrders are all `next/dynamic` — they only load
   when admin actually opens them. Don't undo this without measuring
   bundle impact.
3. **`useMemo` in `materials-view.tsx` is load-bearing.** At 100+ WOs the
   derived data structures (openJobs, visibleJobs, chip flags, etc.) are
   expensive to recompute. Every render path passes the same snapshot
   identity, so memoization stays hot.
4. **`getMaterialsPageAuxData` consolidates two Supabase round-trips** into
   one connection. Was previously two separate loaders that each opened
   their own client and made redundant queries; now they share.
5. **Render-data cache (3-min, in-module)** in `lib/customer-form/render-data.ts`
   speeds up customer-form opens via prefetch on send.

---

## Testing approach (no framework yet)

Today there's no Vitest/Jest setup. Verification is:

1. `npx tsc --noEmit` — full type check
2. `npm run lint` — ESLint (scripts/ warnings allowed; lib/app/components must be clean)
3. `npm run build` — production build must succeed
4. **Manual smoke tests** on the staging test WO Katie provided (`0WOWj000005e9L3OAI`):
   - Send Color Form → email lands → customer opens → picks colors → submits
   - Submit triggers SF writeback (test_only allowlist)
   - Admin notify email fires
   - Open materials modal → review → send to supplier
   - Resend inbound webhook threads supplier reply

When adding new code paths, please verify the manual smoke test still
passes. A test framework is queued for after the platform stabilizes.

---

## Common refactors + how to do them safely

### Adding a new SF field

1. Add to the relevant SELECT in `lib/salesforce/queries.ts`.
2. Add the field to the SnapshotXxx type at the top of the file.
3. Bump the cache key suffix (e.g., `snapshot-v6` → `snapshot-v7`) so
   warm caches with the old shape get invalidated.
4. Update the mapper inside the IIFE that builds the snapshot row.
5. Use the new field downstream.

### Adding a new admin-facing surface

1. Create the page under `app/dashboard/<name>/page.tsx`.
2. Call `loadDashboardData(sp)` (or `{ thin: true }` if you only need
   WO/Account/PaintColor).
3. Pass the bundle into a client component (matches the materials-view
   pattern).
4. If you read `customer_form_tokens`, **filter `kind='preview'`**.

### Adding a new public token-gated form

1. Add the new `kind` value to `customer_form_tokens` (no schema change —
   the column is just TEXT).
2. Update `createToken()` if needed.
3. Add the new kind to every preview-filter site so it's treated correctly
   (or count as customer activity, whichever is intended).
4. Document the new kind in this file + the README's token table.
