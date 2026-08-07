# Materials Ordering Hub — Round 2 (Katie, Aug 2026) · 27-item build tracker

Residential Command Center (`/dashboard/materials`). Every item built to Katie's screenshots/mockups. Status: ⬜ todo · 🔨 in progress · ✅ done. Anchor files: `components/materials-view.tsx` (main list + WO page + entry render), `components/supplier-order-modal.tsx` + `lib/supplier-order/builder.ts` (Order Materials + email), `components/wo-mail-stream.tsx` (mail/activity history), `app/select/[token]` + `app/f/[token]` + `lib/customer-form/*` (entry forms), `lib/salesforce/writeback.ts` (`writeSf`/`writeSfBatch` — SF writeback).

### Confirmed SF field mapping (from `ppp-salesforce-reference/salesforce/DATA_DICTIONARY.md`)
- **WorkOrder**: `FollowupDate__c` (Date) — #03 Follow-up Date. `Scheduling_Notes__c` (Text Area 25000) — #10 append. Already read into the snapshot as `schedulingNotes` in `queries.ts:2095`; add `followupDate` similarly.
- **WorkOrderLineItem**: `ColorNotes__c` (Text) — #09 "Don't paint this surface" note + #11 stop-stacking "Customer notes:". Already read as `colorNotes` (`queries.ts:1583`).
- Writeback pattern: `writeSf({ sObject, recordId, fields })` from `lib/salesforce/writeback.ts`.
- ⚠️ Confirm exact casing `FollowupDate__c` vs `FollowUpDate__c` against the live sandbox before the #03 writeback goes out (DATA_DICTIONARY shows both — WorkOrder section uses `FollowupDate__c`).
- Internal Entry button + Send Color Form live in `materials-view.tsx` (the "Internal Entry" opener component ~L2520); the #03 button bar reuses both.

## Main materials page — `/dashboard/materials`
- ✅ **01 · Layout** — Snapshot band (stat strip + needs-attention + customer-forms strip) gated to `viewer?.isAdmin`; AMs land straight on the WO list. `materials-view.tsx` ~673.
- ✅ **02 · Bug** — Added a scroll-to-top-on-mount effect in focus mode (`materials-view.tsx`, after the focus-refresh effect) so the WO page lands at the top, progress bar visible.

## Work-order page — `/dashboard/materials/[woId]`
- ✅ **03 · Layout** — Reference tab removed; tabs → Button Bar (Colors/Materials sections); Internal Entry in the Colors bar; "Preview Materials Order" + "Order Materials" renames (desktop + mobile); Rooms-and-colors preview kept; **Follow-up Date** shipped — reads `WorkOrder.FollowupDate__c` (probe both casings, deploy-safe retry) + editable field + `/api/dashboard/materials/followup` writeback via `writeSf` (admin/AM gate). `queries.ts` + `materials-view.tsx` + new route.
- ✅ **04 · Layout** — Status/progress bar: bigger text + numbers; **AM attribution** — when AM enters via Internal Entry show "[AM name] Submitted" (e.g. "Amy Submitted") not "Customer Opened/Submitted".
- ✅ **05 · Layout** — "Mail History" → **"Activity History"**; make granular (form sent · opened by customer · colors submitted · form opened by AM · email drafted · sent to supplier…); "Open in Mail Hub" → **"Open Mail Hub"**.
- 🔨 **06 · Bug** — Anchoring: materials→WO lands at TOP ✅ (same fix as #02); WO→pop-ups land at pop-up anchor ⬜ (handled with the Order Materials modal, #20).

## Mail Hub
- ✅ **07 · Layout** — Advanced filtering/sorting: by sender + status (opened/expired/sent/submitted) + by opened/expired/last-activity/follow-up date. Example queries in the brief. (Decide: build into Mail Hub or a separate Activity History Hub.)

## Internal Entry page (`/f/[token]` internal AM)
- ✅ **08 · Layout** — Rewrite copy for internal AM use: first section keep only "Internal entry — you're entering colors on the customer's behalf; saved on submit, no email sent"; remove "Need help picking colors?" + "From your PPP team"; keep paint-line selection; keep Delivery Address but remove its red alert; final block: keep button only, relabel **"Submit colors"**; submitted screen: remove the subtext.

## Both entry pages (Internal + Customer Color Entry)
- ✅ **09 · Process** — "Don't paint this surface" → write to that line item's **Color Notes** in SF: `Customer selected "Don't paint this surface" on [surface].`
- ✅ **10 · Process** — Append "Anything else we should know?" to the **top of Scheduling Notes** in SF.
- ✅ **11 · Bug** — Stop prepending "Customer notes:" on every submission (it stacks). Idempotent.
- ✅ **12 · Layout** — Remove "What we have noted for your job" section entirely.
- ✅ **13 · Bug** — Rooms repeated on line items ("Interior Painting: Living Room: Living Room · Living Room"). Dedupe.

## Order Materials page (`supplier-order-modal.tsx` + `builder.ts`)
- ⬜ **14 · Layout ✓** — Move "Manual quantity required" error ABOVE the "Order — what to buy" area.
- ⬜ **15 · Layout ✓** — Replace `___ (PPP to confirm)` placeholder with ⚠️ / red `*`.
- ⬜ **16 · Decision ✓** — Estimator selects the paint line on this page; per-color selectable, default every color to the main selected line.
- ⬜ **17 · Bug ✓** — "Manual quantity required" banner won't clear when qty typed (driven by SF flag). Clear/soften once every manual-only color has a qty.
- ✅ **18 · Layout ✓** — Drop redundant "(Surfaces)" in the vendor/order line.
- ✅ **19 · Decision ✓** — Fulfillment address: PICKUP blank → pull vendor account address; DELIVERY missing → "DELIVERY — address TBD (admin will confirm before send)".
- ✅ **20 · Bug ✓** — Order pop-up taller than page, can't scroll to buttons. Remove pop-up scroll, add page scroll.
- ⬜ **21 · Bug ✓** — Adjusting gallons doesn't update the TOTAL (line 1 gal but TOTAL 3 gal).
- ⬜ **22 · Layout** — Move primer options out of the product-line dropdown into the **Extras** area.
- ⬜ **23 · Bug** — Line selected but email still shows "⚠ Paint product line not specified".
- ⬜ **24 · Layout** — Add **Fulfillment Date** → populates "Required by: …" in email. Default = start date; if past, next day.
- ⬜ **25 · Layout** — Add **"Color Notes"** field under "Order — what to buy"; move Customer Notes + "Customer is not painting" out of email body into it; rename "Special Instructions" → **"Fulfilment instructions"**; move Fulfilment below "Add custom item (not in catalog)".

## Edge cases
- ⬜ **26 · Bug** — No surfaces in SF but form shows one (WO 00307841) → alert "No surfaces are selected, update Salesforce to collect colors." + **block** sending the color form.
- ⬜ **27 · Bug** — Surfaces in SF but missing from Rooms & Colors (WO 00307837: Cabinets + Door selected in SF, absent from Rooms & Colors).
