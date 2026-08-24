# Held pending Katie — do NOT build

Three items from Kate's round 5 are **logged, not queued**. She was explicit:
*"the last two cards are held — they're logged so they aren't lost, not queued
for building."* This file exists so they aren't lost, and so nobody builds them
by accident.

All three are entangled with work that IS shipped, so the boundary matters.

---

## 08 / R5.1 — Stop writing the paint product line to Salesforce

**Proposal:** `WorkOrder.MaterialType__c` stops being a writeback target; the
hub owns the paint line.

**The case for it, in PPP's own terms:** Salesforce holds one line per work
order. The hub holds a default *plus* per-colour-and-finish overrides, *plus*
both lines on a mixed job — so the hub's model cannot round-trip through the
Salesforce field. And the Salesforce value isn't sitting empty: it's the
estimator's pick carried over from the quote, so every write overwrites their
answer.

**Status: not built.** The submit route still writes `MaterialType__c`.

---

## 09 / R5.2 — The paint-line default should come from the hub

Paired with 08. The email builder resolves the line in this order
(`lib/supplier-order/builder.ts`):

1. what the estimator picked on the order builder
2. what the AM picked on the Internal Entry form
3. whatever was on the work order in Salesforce

The order **page** has 1 and 3 only
(`app/dashboard/materials/[woId]/order/page.tsx`), which is why it could show an
empty dropdown while the email carried a line.

**Status: not built — and deliberately not half-built.**

R5.3 (item 06, shipped) fixed the *symptom* without touching the priority chain:
the draft now REPORTS the line the email resolved, so the screen shows what will
actually be sent instead of contradicting it. That is presentation. Changing
*which source wins* is this held item, and reordering the chain would have been
building it by the back door.

A test in `__tests__/supplier-order/resolved-paint-lines.test.ts` asserts all
three sources are still consulted in the same order, so this stays held even if
someone later "tidies" the resolution.

---

## 10 / R5.5 — Tell the vendor when an order is cancelled

Cancelling is internal only: `app/api/admin/supplier-order/status/route.ts`
flips the status and stamps `cancelled_at`. No email goes anywhere. The vendor
is still holding an order they believe is live.

**If approved:** a cancellation notice to the same address the order went to,
referencing the same PO.

**Status: not built.** What round 5 DID fix is the two things around it:

- the work order no longer reads "ordered" after a cancellation (R5.5 / item 02)
- a cancelled work order can take a new order again (R5.6 / item 01) — the cancel
  screen's own copy tells the admin to "re-send the order to start a new one",
  and that path was blocked

So the internal side is consistent now. The vendor still isn't told.

---

## If these get approved

08 and 09 land together — 09 is most of 08's point. 10 is independent and can go
on its own.
