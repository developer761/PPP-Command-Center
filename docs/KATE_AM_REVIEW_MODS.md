# Kate — "Mods after AM Review Meet"

Source: `Paint Tool Modifications.pdf`, 5 pages, received 2026-10-09 19:23.
A second, separate list from `Paint Tool Mobile Modifications.pdf` — that one
is tracked in `KATE_MATERIALS_MOBILE_QUESTIONS.md` and is complete.

Ten items. One was already shipped before she asked, one is a bug in
something shipped hours earlier, one is prepared and waiting on a real order.

---

## Done

### ✅ Materials Ordering — show the product line from the Quote

Her page 4/5: "Display the product line chosen on the Quote to remind them
what they quoted the project with … It doesn't influence the product line
selections of each color below and there's no way to 'apply default' — it's
simply an informative reminder for the estimator."

**Shipped 2026-10-09 in `c85012b4`, before this PDF arrived**, from her Slack
message earlier the same day. Tests exist specifically to keep it a reminder:
no state is seeded from it, no picker reads it, and the per-color "Product
line required" refusal is untouched.

Her mock-up labels it "Product Line from Quote:"; ours reads "Quoted product
line: X — what the estimator sold." Worth matching her label if she prefers.

### ✅ BUG — the empty template offered the rooms as paint

Her page 1: "On multi-room line items, when the text template for customers
is inserted and the customer doesn't add any colors, the system is trying to
parse out colors and only shows rooms. Example from hub — 00318898."

**Fixed and live in `a3467890`.** One missing character: `parseColorNotes`
only treats a line as a room heading when it ends in `:`, and the template
emitted `Living Room` where it needed `Living Room:`. Without the colon the
room name fell through to `offers` and became a paint to buy.

Her screenshot proved the mechanism: the four rooms she had typed herself
with colons were skipped correctly, and exactly the three the template wrote
without them turned into offers.

---

## Ready, waiting on one real order

### Internal Entry — remove the product line selector (her page 3)

The selector was the only writer of `WorkOrder.Product_Lines__c` (her own
R6.2). A replacement that derives the lines from the real per-color picks
went live in `c5451e53`; the selector comes out as soon as one genuine send
is seen landing the field. Minutes of work after that.

---

## Built 2026-10-09 — all six, live

| Item | Commit |
|---|---|
| Vinyl Siding Colors button | `82ca1b98` |
| Submit verbiage | `82ca1b98` |
| Show the customer's address | `82ca1b98` |
| "Save and email customer" — AM can type the recipient | `5947ab5c` |
| Confirmation screen + affirmation | `b9db44e4` |
| **Bonus: delivery address on the vendor order** | `815c9270` |

Two turned out not to be what they looked like.

**The address was a blank, not a missing feature.** The form already showed
the address whenever it had one. It read the Opportunity's Account BILLING
address; the work order carries the SERVICE address. 372 of 500 work orders
have the second and not the first.

**The same wrong source was costing far more on the vendor order** — its
delivery-address candidates were the customer's form and the account's
billing address, with the work order not among them. That is why orders
printed "DELIVERY — address TBD (admin will confirm before send)" and
somebody typed it by hand. Same 74%. Fixed.

**"Save and email customer" already existed** — Katie asked for it on
2026-10-01. What it lacked was an answer for a work order with no email,
where it said "Add one in Salesforce, then send the receipt" and stopped. The
AM can now type a name and address.

### Not seen rendered

The confirmation screen is customer-only by design and every one of the 222
tokens in the table is expired or submitted. Minting one means writing to a
real job and risking an email to a real homeowner. Mutation-tested instead.

---

## Still open

### Exterior finishes — Kate vs Jason

"Ensure the exterior finishes list shows: flat, soft gloss, semi-gloss."
Today it is **Flat, Satin, Low Lustre, Soft Gloss**.

Hers reverses **Jason's §1 of 2026-09-17** on three points: he said REMOVE
semi-gloss from exterior and ADD low lustre, and she drops satin. Not
changed — it needs the two of them.

### The vinyl link

A Google Drive share URL. It resolves today; the day that file's sharing is
tightened a customer gets a request-access screen with nowhere to go. Every
other link in that card is benjaminmoore.com. Shipped as given, flagged.

---

## Superseded — the original list below



### 1. "Vinyl Siding Colors" button (page 1)

In the "Need help picking colors?" section of the customer form, alongside
"Recommended palettes", "Visualize on a room" and "Exterior stains".

Link: `https://drive.google.com/file/d/1sPNen01-vP0WpGlhr6rJDuIXkE2ykC7z/view?usp=sharing`

**One thing to settle first:** that is a Google Drive share link. It opens for
anyone with the URL today, but it is a PPP Drive file — if sharing is ever
tightened, a customer sees a request-access screen with no way forward. A copy
served from our own domain would not have that failure mode. Worth 2 minutes
of Karan's decision before it ships to customers.

### 2. Submit verbiage (page 3)

Current: "Once you submit, we'll order the materials. You can still come back
and update your colors until Monday, October 26."

Hers: "Once you submit, you'll get an email with your color choices. You can
still come back and update your colors until [date]."

### 3. Confirmation screen (page 3)

After "Submit my colors", show the customer their selections and: "By
clicking 'Confirm my selections' I affirm that I've reviewed these selections
and approve of the use of these for my project."

A real second step, not a dialog — it has to list what they chose.

### 4. "Save and email customer" on Internal Entry (page 3)

A new button; the AM then enters the customer's name and email the same way
they do when sending the color form.

### 5. Exterior finishes: flat, soft gloss, semi-gloss (page 4)

"Ensure the exterior finishes list shows" those three. Check against the
current list before changing anything — Gloss and High-Gloss were withdrawn
on 2026-10-01, so part of this may already be true.

### 6. Show the customer's address (page 4)

Replace the "We have your address on file with our team." placeholder with
the actual delivery address. The "if this is incorrect, reach out" warning
below it stays.

---

## Needs an answer first

### Her p19 primary ask is back

Page 2: "When you implement a multi-room line item is detected and the
ability to add colors in the surface fields are removed from their view, this
error should not show for them on that line item. So if that is the only line
item, it shouldn't show at all. If the multi-room line item isn't the only
line item, then the error shouldn't show for the multi-room line item but
should show for the other line items."

The error is "Nothing was selected yet. Pick a color for at least one surface
— or add a note telling us what you'd like — and submit again."

Two things here, and only one is blocked:

- **The error rules are clear and buildable as written.** No question.
- **The clause they hang off is not.** She is describing the surface pickers
  being REMOVED for a multi-room line — her original p19 primary ask, which
  she had marked "an ask/not required" and for which we built the fallback
  (the room template) instead. She has now asked for the removal twice.

**The question for her:** with the template in place, do you still want the
surface pickers gone on a multi-room line? Removing them means every color on
that line arrives as free text that somebody in the office keys in, and there
is no queue for that work today. If yes, we build it and the error rules
follow naturally.
