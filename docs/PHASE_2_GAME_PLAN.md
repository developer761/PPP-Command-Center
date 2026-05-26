# Phase 2 — Game Plan

**Status as of 2026-05-26 (start of week 2):** Customer Color Form pipeline is **complete + production-safe**. Supplier-email pipeline is **next**, with most of it buildable now using sensible defaults — only 4 narrow questions actually require Katie's input, and those plug into a clean integration point at the end.

---

## What's already shipped (customer side, complete)

| Surface | Where it lives | Status |
|---|---|---|
| Token system (32-byte, 30-day lifecycle) | `lib/customer-form/tokens.ts` + migration 003 | ✅ |
| Resend email integration on `orders.precisionpaintingplus.net` (DKIM/SPF verified) | `lib/email/resend.ts` | ✅ |
| Admin "Send Color Form" modal | `components/materials-view.tsx` `SendColorFormButton` | ✅ |
| Public branded form `/select/[token]` | `app/select/[token]/page.tsx` | ✅ |
| **Form scoped to ONLY the WOLI rows the estimator tagged** | `lib/customer-form/render-data.ts` | ✅ Customer sees only what needs painting |
| Instant color search (all 5,762 colors, client-side filter) | `app/api/customer-form/colors/all` + form Context | ✅ |
| Submit → SF write-back (drift-detected, retried, audited) | `app/api/customer-form/submit/[token]` + `lib/salesforce/writeback.ts` | ✅ |
| Form-status badges on `/dashboard/materials` (Sent / Opened / Submitted / Expired) | `lib/customer-form/wo-status.ts` | ✅ |
| Editable email + form templates (no code deploy) | `lib/customer-form/templates.ts` + migration 004 + `/dashboard/settings/templates` | ✅ |

**Result:** Mrs. Smith gets an email → opens form → picks colors per room → submits → her picks land in Salesforce → her WO shows "✓ Submitted" on `/dashboard/materials`. Zero retyping by PPP staff.

---

## What's next (supplier side)

The **customer submitting their colors automatically produces the data for the supplier email** — that's the magic Karan asked for. The work below is mostly wiring that auto-generation to the dashboard so a PPP worker reviews + sends with one click.

### Phase 2A — Auto-generated supplier email draft (ships THIS WEEK, no blockers)

**Goal:** Replace the disabled "Review & Send" button on `/dashboard/materials` with a real draft modal. Admin clicks → sees the fully-populated supplier email body → reviews → sends.

#### What gets built

1. **`lib/supplier-order/builder.ts`** — generates the supplier email draft from snapshot data + customer-submitted picks:
   - **Header:** PPP account # (env var: `PPP_BM_ACCOUNT_NUMBER`, `PPP_SW_ACCOUNT_NUMBER`, etc.), auto-generated PO (`PPP-WO00012345-001`), required-by date (default: WO close date − 3 days)
   - **Customer + job context:**
     - Customer name (from `customer_form_tokens.customer_name`)
     - **Delivery address** (priority order):
       1. From the customer form if we added a "confirm delivery address" field (see §A.3 below)
       2. Fallback to `Account.BillingAddress` from Salesforce
       3. Last-resort: PPP warehouse address (env var: `PPP_WAREHOUSE_ADDRESS`)
     - WO number + scheduled start
   - **Per-color line items** grouped by manufacturer (BM block, SW block, etc.):
     - Color name + code (e.g. "Stardust 2108-40")
     - Product line (`Regal Select` / `Advance` — defaultable per surface type)
     - Finish (from the customer form pick)
     - Estimated quantity = `sqft × coats / 350` (350 sqft/gallon default; admin can override per line)
     - Surface this color is for (Walls / Trim / Ceiling)
   - **Special instructions** — freeform textarea on the draft modal, persisted to the order row
   - **Reply-to:** `orders@orders.precisionpaintingplus.net` (already configured; per Karan's instruction this lands in the Command Center inbox — see §B reply-handling)

2. **`supplier_orders` table** (migration 005):
   ```
   id, work_order_id, supplier_account_id (BM / SW / etc.),
   po_number, draft_body, special_instructions,
   delivery_address (json), required_by_date,
   sent_at, sent_to_email, resend_message_id,
   status (draft / sent / acknowledged / delivered / received / failed),
   created_by_user_id, created_at, updated_at
   ```

3. **`/api/admin/supplier-order/draft` (GET)** — returns the auto-generated draft for a given WO. Idempotent — running twice returns the same PO number.

4. **`/api/admin/supplier-order/send` (POST)** — accepts admin edits + sends via Resend, writes the row, returns the order id.

5. **Supplier Order Draft Modal** — replaces the disabled "Review & Send" button:
   - Left: read-only summary (customer, WO, colors picked, qty estimates)
   - Right: editable email body (full text) + delivery-address picker + special instructions
   - Bottom: "Copy to Clipboard" (works without Katie's input — admin can paste into Gmail today) + "Send" button (queued until §A.6 done)

6. **Per-supplier templates** — same single-row pattern as customer templates, but keyed by `Account.Id`. Migration 006: `supplier_email_templates`. Defaults shipped in `lib/supplier-order/templates.ts`. BM vs SW vs others can have different greeting / signoff / order-line format. Editable via `/dashboard/settings/templates` (extend the existing page with a per-supplier section).

7. **Order status badge on each WO card** (`/dashboard/materials`) — next to the form-status badge. Shows: "📤 Ordered 5/27 · BM" → "✓ Delivered 5/30". Stage transitions are admin-driven for now (admin clicks "Mark delivered" after the supplier confirms).

8. **Customer-side: optional "confirm delivery address" step** on `/select/[token]` — last step before submit. Pre-filled from `Account.BillingAddress`; customer can edit. Saved into `customer_form_tokens.submitted_payload.deliveryAddress`. Pulled by the supplier-order builder.

#### What this enables today
- Worker on `/dashboard/materials` sees Mrs. Smith's WO with the green "✓ Submitted" badge
- Clicks "Order Materials" → draft modal pops with the full BM email pre-filled (her name, address, WO #, every color + finish + quantity)
- Worker reviews the qty estimates, tweaks if needed, hits Send
- Order goes out to `orders@benjaminmoore.com` (or whatever Katie says)
- BM replies → reply lands in the Command Center inbox (see §B)
- Worker marks "delivered" when materials arrive

---

### Phase 2B — Reply inbox in the Command Center (parallel work)

Per Karan's instruction: **all supplier replies + customer form submissions surface in the Command Center, not Gmail.**

**Architecture:**
1. **Resend inbound webhook** — Resend forwards every email sent to `orders@orders.precisionpaintingplus.net` to `/api/webhooks/resend-inbound`
2. **`/api/webhooks/resend-inbound`** — validates HMAC, parses sender + subject + body + In-Reply-To header, threads to the original send by:
   - **Customer-form replies** → match by `customer_form_tokens.token` referenced in the original message-ID
   - **Supplier-order replies** → match by `supplier_orders.resend_message_id` or PO number in subject
3. **`inbox_messages` table** (migration 007):
   ```
   id, kind (customer_reply / supplier_reply / unmatched),
   linked_token, linked_order_id,
   from_email, subject, body_text, body_html,
   resend_message_id, in_reply_to,
   received_at, read_by_user_id, read_at, archived_at
   ```
4. **`/dashboard/inbox` page** — list view + thread view, filter by kind (customer vs supplier), unread badge in the sidebar
5. **Sidebar nav** — new entry "Inbox" with unread count chip

Effort: ~3-4h to ship the core. The first slice can land WITHOUT the inbox UI (just persist messages to Supabase; worker reads in Gmail until the UI lands).

---

### Phase 2C — The 4 questions Katie needs to answer

These DON'T block Phase 2A from shipping. They determine the **last 5% — which email address the orders go to + small format tweaks per supplier**:

| Q | Why it matters | Default until Katie answers |
|---|---|---|
| 1. What's the BM order format? Plain email / PDF / portal? | Plain-text email is what we ship by default. If they need PDF or portal upload, we add an export button. | Plain email |
| 2. PPP's account number with BM, SW, Romeo's, etc.? | Goes in every order email header. | Env var per supplier; ship without values, supplier draft shows `[ACCOUNT #]` placeholder until set |
| 3. Default delivery address — warehouse or job site? | Customer-form delivery-address step picks this default. | Job site (from Account.BillingAddress); worker can override per order |
| 4. Where supplier replies should go? | Determines Resend inbound config. | Command Center inbox (already decided per Karan's directive) |

The integration point: when Katie answers, we update env vars (Q2) + tweak one config object in `lib/supplier-order/builder.ts` (Q1) + change a default constant (Q3). 30 min of work, max.

---

## Sequencing (ship plan for this week)

| Day | What ships | Hours |
|---|---|---|
| Tue (today) | Audit + UX polish (DONE in commit d6de960) + this game plan doc | 1h |
| Wed | Migration 005 + `lib/supplier-order/builder.ts` + draft generator (copy-to-clipboard works without Katie's input) | 2-3h |
| Wed | Supplier Order Draft Modal in materials-view, replaces disabled "Review & Send" button | 1h |
| Thu | `/api/admin/supplier-order/send` (Resend send + DB write + status badge) | 1-2h |
| Thu | Per-supplier templates (`supplier_email_templates` migration + extend templates editor) | 1h |
| Fri | Resend inbound webhook + `inbox_messages` table + minimal `/dashboard/inbox` page | 3-4h |
| Fri | Customer form "confirm delivery address" step | 30m |
| When Katie answers | Update env vars (account #s) + delivery default + format tweaks | 30m |
| **Total** | **Phase 2 fully shipped** | **~10-13h** |

---

## What "perfect" looks like (definition of done for Phase 2)

End-to-end test PPP staff can run on launch:

1. Pick any open paint-job WO on `/dashboard/materials`
2. Click "Send Color Form" → customer email goes out under the editable template
3. Customer opens link → form scoped to ONLY their WO's lines → instant color search → picks colors per room → confirms delivery address → submits
4. WO card flips to "✓ Submitted" + the colors land in Salesforce on the WOLI rows
5. Worker clicks "Order Materials" → draft modal pre-fills the supplier email with EVERYTHING (PPP account #, PO, customer + address, per-color line items + finishes + qty estimates, required-by date)
6. Worker reviews qty estimates, adds special instructions, hits Send
7. Order email goes to BM. Reply lands in `/dashboard/inbox` (NOT Gmail).
8. Worker reads the reply (BM's confirmation + delivery date), marks order "acknowledged" → "delivered" as it progresses
9. Every step is editable via `/dashboard/settings/templates` — Katie can tweak the customer email, the form thank-you message, the BM email greeting, etc. without a deploy

**No retyping. No copy-pasting. No "did Mrs. Smith pick her colors?" question. Replies all in one place.**

---

## What I need from you (only 4 things)

These are all NICE-TO-HAVE — Phase 2A ships without them; they enable the final 5%:

1. Get Katie to confirm the 4 questions in §2C (BM order format, account #s, delivery default, reply destination)
2. Configure env vars in Vercel: `PPP_WAREHOUSE_ADDRESS`, `PPP_BM_ACCOUNT_NUMBER`, `PPP_SW_ACCOUNT_NUMBER`, supplier email addresses
3. Run migrations 005 + 006 + 007 in Supabase SQL Editor (I'll provide each as it ships)
4. Configure Resend inbound webhook on `orders.precisionpaintingplus.net` (DNS already verified; just needs the webhook endpoint URL added in Resend dashboard) — instructions in §2B comments
