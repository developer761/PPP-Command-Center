# Kate — "Paint Tool Mobile Modifications", the items that need an answer before we build

Source: `Paint Tool Mobile Modifications.pdf`, Kate, received 2026-10-07.

Her cosmetic items are **done and live** as of 2026-10-08 (commits `4a01cd33`,
`68ca1e11`). This file is only the items that change how the tool WORKS, which
is why they are questions rather than commits.

Two things to know before reading:

- **One of them reverses a decision Katie made on 2026-09-08**, and that panel
  has already been flipped once. It needs the two of them to agree, not us.
- Everything here is the residential Materials Ordering flow — the order
  builder (`/dashboard/materials/<wo>/order`) and the customer color form.

---

## 1. "Line items on this WO" — collapse it? Katie asked for the opposite

**Kate wants:** the panel collapsed by default.

**Katie asked for the exact opposite, 2026-09-08, her item 9:** *"line items
should be all the way at the top for material ordering and don't have it as a
dropdown."*

**And it has already been flipped once.** R4.18 collapsed the panel and moved
it last, on the grounds that an expanded copy of the source data pushed the
buy-list off the first screen — which is Kate's point now. Katie reversed that,
because the office checks the buy-list AGAINST the source data, so it has to be
visible before the numbers rather than after them.

So both positions are already on record, with a reason each, from two different
people. Flipping it a third time on one person's note is how it ends up flipped
a fourth.

**The question for Kate and Katie together:** who checks the buy-list against
the Salesforce line items, and do they do it on a phone? If the answer is "the
office, on a desktop" then Katie's layout is right and the fix is to collapse it
on mobile only. That satisfies both and is the one option nobody has rejected.

Reference: `components/order-builder-view.tsx` around the `#preview` section.

---

## 2. Vendor selection to the top of the page

**Kate wants:** the vendor picker first.

No conflict found — nothing on record argues for its current position.

**The question:** the vendor filters which products and prices are even
offered, so moving it first is an argument for locking it once chosen. If
somebody picks Aboffs, builds twelve lines, then switches to Ricciardi, what
should happen to the twelve lines — keep them, clear them, or warn? Today the
order is built first, so the question never came up.

---

## 3. Remove the color-notes adder from the line-item cards

## 4. Put that color into the custom-color area, with a quantity

These two are one change and need one answer. Today a color note parsed off a
line item is added from the card it came from; Kate wants it to land in the
custom-color area instead, with a quantity.

**The question:** when it lands there, does it keep the room it came from? The
custom-color area is currently vendor-wide and roomless, which is why identical
lines from two rooms now merge into one line with the quantities summed (shipped
2026-10-08). If a moved color keeps its room, that merge has to stop; if it
doesn't, the order loses which room the color was for — and that is what the
store calls about.

---

## 5. Flag duplicate colors, and remove the quantity adder

**Kate wants:** duplicate colors flagged, and the quantity adder gone.

**Partly shipped already, which may be the whole of it.** As of 2026-10-08
identical lines for one vendor (same color, finish, product and unit) are
combined into a single line with the quantities summed, rather than shown twice.
That was Karan's call on her note about two rooms sharing one color and
producing two identical vendor lines.

**The question:** does the merge cover what she meant by "flag", or does she
want a visible warning as well — and is "remove the quantity adder" asking us to
drop manual quantity entry entirely, so the estimate is the only source? That
second one is a real behavior change: the estimate is a calculation, and the
people ordering currently override it.

---

## 6. "Multiple rooms detected on one line item" alert

**Kate wants:** an alert when one Salesforce line item covers several rooms.

**The question:** what should it say, and is it a warning or a blocker? We can
detect it, but the useful version tells somebody what to DO — and the fix is in
Salesforce, not here. Also: is a line item covering several rooms a data-entry
mistake to be corrected, or a normal thing the estimators do on purpose? That
changes whether this is an error or a note.

---

## 7. Only show the accent-wall alert when a wall is actually painted

**Kate wants:** no accent-wall alert on a line item with no walls.

**Reasonable, with one caveat to preserve.** The alert fires per ROOM on
purpose, not per color — deliberately, because an accent wall is its own color,
and flagging only the accent line left the WALLS line unflagged, which is the
line whose quantity is actually thrown off.

So the change we'd make: suppress it where the room has no painted walls at all
(trim-only or ceiling-only), and keep it on the walls line everywhere else.

**The question:** is that what she means? If she means "only on the accent line
itself", that reintroduces the bug the per-room detection was added to fix.

Reference: `lib/supplier-order/estimate-gallons.ts`, `roomHasAccent`.

---

## 8. Customer form, multi-room line item: drop the surface fields, notes only

**Kate wants:** where one line item covers several rooms, the customer form
shows no surface pickers — just a notes box.

**The question:** the form's whole output is a color per surface, and that is
what the order is built from. If a multi-room line item returns only free text,
somebody has to read it and key the colors in — who, and on which screen? There
is no "unparsed customer note" queue today. Worth confirming she wants the
tradeoff, because it moves work from the customer to the office.

---

## 9. The "random order materials button at the bottom of the page" (her p15)

**Found it.** On a phone there are two identical "Order Materials" buttons
pointing at the same route: one in the Materials card, and a sticky bar pinned
to the bottom of the viewport (`lg:hidden`).

**The sticky bar was Karan's own call, 2026-06-13** — so workers don't have to
scroll past the full action toolbar to reach it. That is a real reason, and it
is why this is a question and not a deletion.

**The question for Karan, not Kate:** keep the sticky bar and drop the one in
the Materials card on mobile, or the reverse? Both buttons go to the same place,
so one of them is redundant on every phone screen. The sticky bar is the one
Kate noticed as "random", because it floats with no label or context.

Reference: `components/materials-view.tsx`, the `lg:hidden` sticky bar.

---

## 10. Her item 21 — pasted into Gmail as percent-encoded text

**Cause not found.** We looked: there is no `mailto:` link and no encoding step
anywhere in the order flow, so we cannot reproduce it from the code.

**What would settle it:** which button she pressed, and whether the mangled text
appeared in the Gmail compose window or in the sent message. A screenshot of the
paste would do it. Percent-encoding appearing on paste usually means the copy
came from a URL rather than from the page text, so knowing the button narrows it
immediately.

---

## Answered already, no action needed

Her cosmetic items are live: the rep popover running off the left edge, the
notification panel, the help circles being too small to hit, the chips, the unit
toggle, the work-order progress bar printing an ID fragment as a title, and the
error banner contrast. Verified at 390px.
