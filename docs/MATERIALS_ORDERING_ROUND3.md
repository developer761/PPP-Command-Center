# Materials Ordering Hub — Round 3 (Kate, Aug 2026) · 33-item build tracker

Residential Command Center (`/dashboard/materials`). Status: ⬜ todo · 🔨 in progress · ✅ done.
Predecessor: `MATERIALS_ORDERING_ROUND2.md` (27 items, closed 2026-08-08 @ `ebc82318`).

**Kate's sequencing (approved by Karan):** #18 (Order Materials split) FIRST — #20/#21/#22/#26 are
suspected symptoms of it. Anything that turns out independent gets flagged and treated separately.

Anchor files:
- `components/materials-view.tsx` (3025) — list + WO page + button bars + Internal Entry opener
- `components/supplier-order-modal.tsx` (1636) — Order Materials
- `lib/supplier-order/builder.ts` (1025) — the vendor email
- `lib/supplier-order/estimate-gallons.ts` — gallon math + `formatOrderQuantity`
- `components/customer-form-view.tsx` (1643) — both entry forms
- `components/wo-mail-stream.tsx` (213) + `components/work-order-progress-bar.tsx` (337) — activity/attribution
- `lib/wo-progress/derive.ts` + `lib/materials-page-data.ts` — **two** progress loaders (drift risk)
- `components/inbox-view.tsx` (1099) — Mail Hub
- `app/api/customer-form/submit/[token]/route.ts` (780) — submit + SF writeback
- `lib/customer-form/material-types.ts` — the product-line picklist

---

## ⚠️ Root causes confirmed by code read (before building)

| Item | Confirmed root cause |
|---|---|
| **#02** AM attribution missing | **Round-2 #04 was built in the wrong loader.** `lib/wo-progress/derive.ts:142-175` populates `submittedByName` correctly — but that loader only feeds `app/dashboard/page.tsx` (Overview). Both `/dashboard/materials` and `/dashboard/materials/[woId]` load via `lib/materials/view-props.ts` → `getMaterialsPageAuxData` (`lib/materials-page-data.ts`), which never selects `created_by_user_id` and never sets `submittedByName`. The comment at `derive.ts:126` claims the two are "kept in lock-step" — they are not. Cheap fix. |
| **#22** manual qty resets | `supplier-order-modal.tsx:298` — `setQuantityOverrides(new Map())` fires on **every** draft refetch, and the refetch effect (`:247`, deps `:310`) reruns on extras / fulfillment / instructions / colorNotes / materialType change. Second half ("extras don't reach the email") is the same chain: `adjustQuantity` sets `editedBody`, which then pins the body (`:1338` `editedBody ?? draft.body`) so later extras never render. |
| **#26** total climbs while line says "manual entry required" | The per-line list at `:811` maps **`draft.gallonEstimates`** (raw, `manualOnly` still true) and passes `{...e, buckets, cans}` into `formatOrderQuantity`, which short-circuits on `manualOnly` (`estimate-gallons.ts:383`) and returns "manual entry required" regardless of qty. The TOTAL at `:800` uses `effectiveEstimates` (`:159`), which *does* clear `manualOnly`. Two different sources → the exact contradiction Kate saw. |
| **#06** "1 color need" | `supplier-order-modal.tsx:765` pluralizes the noun ("1 color" / "N colors") but hardcodes the verb "have". Same bug in the second banner at `:773`. |
| **#32** past "Required by" | `:953-959` — bare `<input type="date">`, no `min`. |
| **#09/#24** line+finish in picker | `lib/customer-form/material-types.ts:47-54` — values ARE line+finish ("Regal Select Eggshell", "Ultra Spec Interior Flat"). Kate wants line only (Ultra Spec / Regal Select / Ben / Aura). ⚠️ These values are written to SF `MaterialType__c` and gate the submit allowlist (`VALID_MATERIAL_TYPE_VALUES`) — see Risks. |
| **#08** primer on Internal Entry | Round-2 #22 filtered primers out of the **order modal** pickers only (`supplier-order-modal.tsx:169-174` `lineMaterialValues`). The customer/internal form picker was never filtered. |

---

## Work-order page — `/dashboard/materials/[woId]` · 0/7
- ✅ **01 · Layout** — Remove the duplicate Internal Entry button (renders twice: beside Send Color Form, and again under Send Reminder).
- ✅ **02 · Bug** ↻R2#04 — Progress bar + activity read "Customer Submitted" for AM entries; must read "Amy Submitted". Root cause above.
- ✅ **03 · Bug** ↻R2#05 — Activity history not granular; no customer-vs-AM attribution on opens. Needs: form sent · opened by AM · opened by customer · colors submitted (by whom) · email drafted · order sent to supplier.
- ✅ **04 · Bug** ↻R2#06 — Pop-ups mount without moving the viewport to their anchor. Affects Send Color Form, Preview Materials Order, vendor selection.
- ✅ **05 · Layout** — Sq Ft alert still claims a Salesforce save. Drop "we save it to Salesforce automatically and". Also verify sqft persists in CC (should already, via `wo_li_sqft_overrides` / migration 073).
- ✅ **06 · Layout** — "1 color need a manual quantity" → "needs". Verb not pluralized.
- ✅ **07 · Process** — Sender-set color deadline. Date field on the send form, always present; default = WO Start Date when one exists, else empty; never render a past date. (68% of WOs in Coordination/Scheduling have no start date — the current Close-Date fallback is always expired.)

## Internal Entry page (`/f/[token]`) · 0/2
- ✅ **08 · Layout** ↻R2#20 — Primer still in the product-line picklist here; move to Extras as done on Order Materials.
- ✅ **09 · Layout** — Product line picker must list the LINE only (Ultra Spec, Regal Select, Ben, Aura), not line+finish. Finish is already captured per surface. Applies to AM form AND order form.

## Both entry pages · 0/1
- ✅ **10 · Process** — Non-standard surfaces (Walls/Ceiling/Cabinets/Door) write overflow to SF Color Notes correctly, but are then cleared from the CC surface fields. Push to SF **and** keep the CC copy exactly as entered.

## Mail Hub · 0/3
- ✅ **11 · Layout** ↻R2#07 — Regroup filters: Sender · Status · [3 date picklists as one visually-separated set]. Add supplier statuses to Status options.
- ✅ **12 · Layout** — Remove the redundant "Newest first" header label now that sorting is in the filters.
- ✅ **13 · Bug** — Follow-up date filter returns zero results on any date.

## Preview Materials Order · 0/4
- ✅ **14 · Layout** — "Line items on this WO" (Source data → Salesforce): show room + surface per line.
- ✅ **15 · Bug** — Order draft preview: each color labelled generic "Area", colliding with the Source-data "Area". Replace with room + surface.
- ✅ **16 · Layout** — Add a Color Notes section (holds color/finish for orphaned surfaces + non-BM/SW colors).
- ✅ **17 · Layout** — Wording check only, after #18 moves the paint-line picker here: "⚠ Paint line not set — customer or admin needs to pick".

## Order Materials page · 0/15
- ✅ **18 · Process · KEYSTONE** — Split into order-building (→ Preview Materials Order: paint line, "Order — what to buy", color notes, extras; vendor selection becomes an inline pick list) and fulfillment-only (required by, supplier, fulfilment instructions, email body). **Persist order state on transition**; fulfillment reads saved state and cannot mutate the order payload. Fix the overlay scroll context (or make it its own page).
- ✅ **19 · Layout** — "Type in the gallons with the +/- buttons below." → "Update the gallons using the +/- buttons below."
- ✅ **20 · Bug** — Tab switch drops all entered data and ejects to the WO page. Intermittent — behaves like a periodic re-sync re-mounting while the tab is inactive.
- ✅ **21 · Bug** ↻R2#06+#18 — Vendor pop-up doesn't anchor; scroll trap persists into Order Materials. Adopt the Preview Materials Order scroll setup.
- ✅ **22 · Bug** — Manual quantities reset when extras/fulfillment/product line change; product line then missing from the email; extras added after quantities don't reach the email. Root cause above.
- ✅ **23 · Bug** — Per-color product-line override either omitted from the email, or listed but quantities fall back to "(PPP to confirm quantities)".
- ✅ **24 · Bug** ↻R2#15 — AM's Internal Entry product line doesn't reach the order form (picklist arrives empty). Shape may change with #09.
- ✅ **25 · Layout** — "Order — what to buy": show room(s) + surface per color line. Same colour used in two rooms currently collapses to one line reading just "Walls". Pairs with #15.
- ✅ **26 · Bug** — With no sq ft, + climbs the TOTAL while the line still reads "manual entry required". Root cause above.
- ✅ **27 · Layout** ↻R2#21 — Per-line unit selection: gallon **and quart** (~1/5 of containers bought are quarts/pints). Not built in round 2.
- ✅ **28 · Process** ↻R2#24 — Split "Add custom item" into custom **sundry** item (exists) and custom **color** item (new; between "Order — what to buy" and Color Notes; one typeable field, help text "Color and finish — e.g. Color Match: Behr 56, eggshell"; qty + unit like any line). Unblocks the rest of R2#24: Customer Notes + "customer is not painting" move out of the email body into Color Notes.
- ✅ **29 · Process** — Supplier order email carries no contact. Store a phone per user (new — captured at account setup), default the order's phone field to it, editable per order without changing the stored default.
- ✅ **30 · Process** — Failed SF writes are silent. (a) show the saver an error at the moment it fails; (b) email that user their submitted content so it isn't lost; (c) notify Kate + Katie (email or Slack).
- ✅ **31 · Bug** — Color Notes compilation labels every entry "Room" instead of the real room name, and runs surfaces together on one line. Want real room name + line break per surface. Same for free-text notes.
- ✅ **32 · Bug** — "Required by" accepts a past date. Root cause above.

## Edge cases · 0/1
- ✅ **33 · Bug** ↻R2#25 — No surfaces in SF but the form still renders one. Alert "No surfaces are selected, update Salesforce to collect colors." + **block** sending the color form. (Round 2 marked this done as #26 — re-verify what actually shipped.)

---

## Risks / to raise with Kate
1. **#09 product-line reshape** — the finish-bearing values are written to Salesforce `MaterialType__c` and gate the server-side submit allowlist. Collapsing to line-only changes what lands in SF. Need to confirm the SF picklist accepts bare "Regal Select" / "Ultra Spec", and decide what happens to WOs already carrying "Regal Select Eggshell". Also "Ben" isn't in the current list at all.
2. **#29 phone per user** — genuinely new: schema + Access/account-setup UI + order-form field. No phone is stored anywhere today.
3. **#30 failed-SF-write surfacing** — three deliverables (inline error, email-back-to-user, notify Kate/Katie). The notify channel is Kate's choice (email vs Slack).
4. **#03 activity granularity** — Kate pre-flagged this as a possible big lift. The data needed (token `kind`, `created_by_user_id`, `supplier_orders` rows, sent/inbox messages) all exists, so it's moderate, not days — but attribution of *opens* needs the open event tied to the token kind.
