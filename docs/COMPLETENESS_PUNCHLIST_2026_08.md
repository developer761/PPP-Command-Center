# Completeness punch-list (2026-08) — "should've been caught" gaps

From a 6-lane + adversarial-verify workflow (20 raw → **20 verified**, 0 agent
errors) hunting the shape the partial-WO bug had: a feature is built but a PIECE
is unwired, silent, or missing — so it under-delivers. Every item is code-grounded
with `file:line` for BOTH the definition and the missing wiring.

Ownership: **build session** fixes; verification session found + rechecks. Not
consistency (that's `CONSISTENCY_PUNCHLIST`) and not the in-flight specs.

> Several "medium" items are money- or RBAC-facing — treat those as high in
> practice. Flagged 💰/🔐 below.

---

## 🔴 HIGH

### C1. Proposal PDF prints a HARDCODED Tomco footer — ignores the editable operating-company fields
The flagship customer doc. `proposals/pdf.tsx:1389-1394` prints a literal `77-13 Windsor Place • … • Tel 631.582.2770 • Fax … • www.tomcopainting.com`. `RenderProposalArgs` has no `company` field (`pdf.tsx:1201-1207`); neither caller passes one (send `proposals/db.ts:2256`, preview `api/commercial/proposals/[proposalId]/pdf/route.ts:113`) — even though `db.ts` already imports `getOperatingCompany()` for email logic. Work-orders + closeout PDFs thread it; the proposal is the lone outlier.
**Impact:** edit company phone/fax/web/address in Settings (or a rebrand/licensee) → WOs + closeout update, but **proposals keep going to GCs with stale contact info** — wrong callback details on the exact doc a customer replies to.
**Fix:** add `company: OperatingCompany` to `RenderProposalArgs`, pass `getOperatingCompany()` from both callers, render the footer from those columns.

---

## 🟠 MEDIUM (money/RBAC ones marked)

### C2. 💰 Void invoice = no confirm, and it HARD-DELETES change-order billing while advertised as reversible
Void is presented as a safe flip ("Flip whenever it fits your flow", "Reopen as draft" — `invoices/[id]/page.tsx:1179,1197`) via a plain `<button>` (no `ConfirmSubmitButton`, unlike removePayment at `:1386`). But void → `releaseTickedChangeOrders` **hard-deletes** the invoice's CO line items (`invoices/status.ts:139`); reopen-as-draft restores only the base invoice, **not the CO lines**.
**Impact:** user voids a CO-bearing invoice expecting to reopen it, and the CO charge is **gone**, the total dropped, the CO back to unbilled — a silent revenue drop at the moment of a "reversible" action.
**Fix:** wrap Void in `ConfirmSubmitButton` when the invoice has CO lines ("Voiding un-bills N change order(s); reopening won't restore them"); ideally restore CO lines on reopen instead of hard-deleting.

### C3. 💰 Tax-exempt customer is NOT honored on the change-order billing path
The deal invoice form forces 0% for `account.tax_exempt` (`accounts/[id]/page.tsx:2300-2302`), but `change-orders/db.ts:406-410 dealTaxPct()` (auto-mints a CO-billing draft at `:451`) computes tax **only from the ZIP** and never reads `account.tax_exempt` (though `co.account_id` is in hand). `createCommercialInvoice` doesn't zero it either.
**Impact:** ticking a CO to bill a **tax-exempt** GC with no existing draft auto-creates an invoice **pre-filled with sales tax** — the exact silent mis-bill the deal form was hardened against, reachable via the CO path.
**Fix:** in `dealTaxPct()` fetch the account and return 0 when `tax_exempt` before the ZIP fallback (or enforce centrally in `createCommercialInvoice`).

### C4. 🔐 Deal-delete confirm understates the cascade (wipes invoices/costs/crew silently)
Delete cascades: soft-deletes unpaid invoices, tombstones purchases/costs, tears down the Field Ops WO + cancels future crew shifts (`opportunities/mutations.ts:379-421`). But both confirms say only "remove {title} from the pipeline" (`accounts/[id]/page.tsx:8402`, `opportunities/[id]/page.tsx:3011`). The correctly-scoped warning already exists one file over (`accounts/[id]/edit/page.tsx:382-385`).
**Impact:** deleting a duplicate deal silently wipes its invoices, recorded costs, and **un-schedules crew from upcoming shifts** — invisible until someone notices missing money or a crew that never got dispatched.
**Fix:** reuse the account-delete warning block — enumerate "N invoices, recorded costs, N scheduled work orders/crew shifts" when present; drop the "from the pipeline" wording.

### C5. 🔐 Employee deactivation leaves ghost future assignments (fired worker still scheduled)
`updateEmployee` deactivation (`field-ops/employees.ts:219-236`) only resets clock-reminder emails — it never touches `commercial_assignments`. `getMonthOverview`/`getDaySchedule` (`schedule.ts:155-156,241`) join names with **no `active` filter** (only copy-week filters active).
**Impact:** a fired/deactivated crew member **keeps showing as scheduled** on upcoming shifts and inflates headcount + scheduled-hours, with no "inactive" flag. A manager can dispatch a ghost worker or read wrong labor numbers.
**Fix:** on `active→false`, cancel that employee's future (`>= todayEtIso()`) non-cancelled assignments (mirror `deleteAssignmentById`'s reminder resync); and/or surface `active` through the schedule reads so legacy rows are flagged.

### C6. Closeout Transmittal + Warranty PDFs can address to "—"
`to_company` is null on every fresh package (`closeout/db.ts:111-122` has no `to_company` on insert) and only persists if the operator edits the cover form (autosave fires on change, not load). Both PDFs fall back to literal `"—"` (`closeout/pdf.tsx:92,155`) — even though both routes already loaded `accountName` and never pass it in (`transmittal/route.ts:40`, `warranty/route.ts:42`). The screen previews use `account.company_name`.
**Impact:** a GC receives a Transmittal reading "Transmitted to: —" and a **Warranty addressed to "—"** (its only addressee) — a warranty with no named beneficiary is unusable — while the operator's screen looked fine.
**Fix:** pass `accountName` into both renderers; `pkg.to_company || accountName || "—"`; seed `to_company = account.company_name` at package create.

### C7. 💰 Remove-payment action swallows failure
`removePaymentAction` (`invoices/[id]/page.tsx:224-237`) discards `removePayment`'s `{ok,error}` return and unconditionally redirects — unlike its siblings `removeLineItemAction`/`addPaymentAction` on the same page.
**Impact:** if un-recording a payment fails, the payment **stays on the invoice**, balance unchanged, and the user gets **zero feedback** — they think the money was removed.
**Fix:** capture the result; on `!ok` redirect with `?error=` (mirror `removeLineItemAction`).

### C8. 🔐 Team remove-member / role-change swallow BOTH the error and the silent admin hand-off
`removeMemberAction`/`updateMemberAction` (`settings/teams/page.tsx:76-97`) discard the return. The source returns `{ok:false,error}` on failure AND a `promotedAdmin` heir when the sole admin is removed/demoted (`teams/db.ts:257-259,397-405`). Siblings surface errors; nothing consumes `promotedAdmin`.
**Impact:** a failed change looks like it worked (RBAC not actually set); and when the only admin is removed, **team-admin authority silently moves to someone else with nobody told who** — RBAC changed invisibly.
**Fix:** capture the return; on `!ok` redirect `?error=`; when `promotedAdmin` set, redirect with a heads-up ("Team-admin handed to <name>").

### C9. 🔐 Employee activate/deactivate action swallows failure
`toggleActiveAction` (`field-ops/employees/page.tsx:119-127`) ignores `updateEmployee`'s Result and redirects unconditionally — unlike its two siblings.
**Impact:** a failed deactivate looks done → a **still-active worker who can be scheduled and clock in**; reactivate can silently no-op. (Compounds C5.)
**Fix:** check the result; on `!ok` redirect `?error=`.

---

## 🟡 LOW (batch)
- **C10. Silent-action deletes** — five more actions swallow their `{ok,error}` Result (inconsistent with siblings), so a failed delete leaves the row with no feedback: **delete job** (`field-ops/jobs/page.tsx:113-118`), **delete team** (`settings/teams/page.tsx:57-64`), **delete closeout item** (`closeout-tool.tsx:270-283`), **delete AIA G703 line** (`aia-tool.tsx:324-337` — a swallowed failure makes the payment-app total look wrong), **toggle schedule-email opt-out** (`settings/access/page.tsx:78-84`). Same one-line fix each: capture result, redirect `?error=` on failure.
- **C11.** Proposal PDF ships with **no estimator contact block** when the deal has no estimator + nobody typed one (`proposals/pdf.tsx:1168-1182` returns null; `hydrate.ts:113-123` leaves `{}`). GC gets a proposal with no named point of contact, no warn at send. Fix: default the estimator snapshot to the owner/approver at create, or warn on approve/send when empty.
- **C12.** Tax-exempt **cert # never surfaced** on any invoice/statement (`accounts/db.ts:39` collected, no consumer). A $0-tax invoice shows no substantiation. Fix: show "Tax-exempt — Cert #…" near the tax line when the account is exempt.
- **C13.** Dead `suggestedTaxPct`/`taxHit` on the global invoices page (`invoices/page.tsx:1832-1833`, computed, never read, and wouldn't respect `tax_exempt`). Remove it (or wire it with an exemption check). Latent trap.
- **C14.** `formatCentsFull` missing the `Number.isFinite` guard its sibling `formatCentsCompact` got in the 2026-08 edge audit (`invoices/format.ts:39-44` vs `:12-16`) — a future NaN caller renders "$NaN". Add the guard for symmetry.
- **C15.** `ComingSoonTab` dead code (`accounts/[id]/page.tsx:6541`, no caller). Delete it.

---

## Notes for the build session
- **C7–C10 are one mechanical class** — "capture the Result, redirect with `?error` on failure (+ heads-up for `promotedAdmin`)." Batch them together; ~9 actions, same shape.
- **C2, C3, C4, C5 are the real-money / real-dispatch ones** — do these first.
- Verification session will recheck each against the code (does the setter/consumer now exist).
