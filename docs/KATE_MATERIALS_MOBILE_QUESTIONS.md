# Kate — "Paint Tool Mobile Modifications": every item, and what is left

Source: `Paint Tool Mobile Modifications.pdf`, 23 pages, received 2026-10-07.

**This file was rewritten on 2026-10-09 after re-reading the PDF page by page.**
The first version was written from notes and was wrong in two directions: it
listed things as needing Kate's decision that she had already specified
exactly, and it missed that several of her items were only half-built. Nine of
her annotations live inside the page images rather than the text, which is how
they were lost.

Every item below is checked against the running app at 390px.

---

## Done and live

| # | Page | Item | Verified |
|---|---|---|---|
| 1 | p1 | "All reps" / bell pop-up opens off-screen | popover sits inside the 390px screen |
| 2 | p3 | Top bar should scroll with me; clock and battery overlap the text | `position: sticky`, `top: 0`, opaque white, top safe-area padding |
| 3 | p4.1a | Rename "Buy-list" to "Order — what to buy" | heading and the stray reference both |
| 4 | p4.1 | Flag **"This color already exists on the order. Increase quantity above."** and remove the quantity box there | her wording verbatim; Qty/unit/Add no longer render on an already-ordered color |
| 5 | p6 | Enlarge text on the gallon/quart/bucket selector | 13px, was 11px |
| 6 | p8 | Invert the error colors — darker red alert, lighter red text | inverted |
| 7 | p11 | Highlight the field itself in transparent red | ring + 10% tint on the field |
| 8 | p12 | Awkward progress-bar spacing, and "DZFOAW" at the end of the title | ID fragment gone; steps read "Form sent" … "Order sent" |
| 9 | p15 | Random order-materials button at the bottom | the sticky bar now appears only once the other button scrolls away, so there is never a second copy |
| 10 | p17 | Make the help circles smaller | 16×16 ring inside a 44px touch target |
| 11 | p17 | The colorful bars should extend the whole way over, whatever the text length | all four bars uniform width at 390px |
| 12 | p18 | Move Vendor to the top of the page | first card on a phone; laptop layout untouched |
| 13 | p18 | Make "Line items on this WO" collapsible and collapsed by default | collapsed on a phone with a Show/Hide control; laptop unchanged |
| 14 | p18 | Make the unit toggles consistent | every row renders Gallon/Quart/Bucket |
| 15 | p18 | Only show the accent alert when the color is picked for a wall | suppressed where the room paints no walls |
| 16 | p18 | Add room names and "requested" — "Accent wall requested in Dining Room" | wording matches |
| 17 | p18 | Make alerts yellow and errors red | the accent alert is amber |

**12 and 13 are phone-only on purpose.** Katie asked for the opposite on
2026-09-08 ("line items should be all the way at the top … don't have it as a
dropdown"), and the panel had already been flipped once. Karan 2026-10-09:
"for the phone follow kates rules the laptop should stay exactly as is."

---

## Not built yet — and most of it does NOT need Kate

### A. Move the bathroom-ceiling indicator into the custom color area (p4.2 + p18 "Remove this")

Two annotations, one change. Today a color parsed out of the notes shows an
amber chip — "eggshell for the bathroom ceiling" — beside its own inline
quantity box on the line-item card. She wants the inline adder **removed**
(p18, arrow at that block) and the color **added to the custom color area for
the guys to add a quantity** (p4.2), because the chip alone never tells anyone
that Super White in eggshell has to be ordered as a custom color.

**One question, and it is the only real one here:** when that color lands in
the custom color area, should it carry the room it came from? It matters
because custom lines merge on the vendor's copy by color, finish, product and
unit — room is not in that key, so if the room travels with it, that merge has
to stop or one room's name silently wins.

### B. "Multiple rooms detected on one line item" (p18) — BUILT AND LIVE

Her wording, verbatim. Built 2026-10-09 against 711 live interior line items
rather than invented examples, which is the only reason it works: a plain
"two room words" pass called 24.6% of line items multi-room and was wrong
most of the time.

It now flags **95 of 711 interior lines (13.4%)** — this really is a common
data-entry pattern, which is why she noticed it.

**One thing for Kate to rule on, with real examples rather than a question
in the abstract.** Precision is not uniform. Lines naming 3+ rooms are close
to clean. The 2-room band is 44 of the 95 and roughly 70% right. The two
patterns we chose to leave IN, because the alert is advisory and "confirm
with the customer" costs little:

- `Small stairwell off of 3rd floor office` — the office says where the
  stairwell is. One room, flagged as two.
- `prep and paint kitchen walls and ceiling. pantry door a separate color` —
  the pantry qualifies a door. Arguably worth confirming anyway.

Ask her: should either of those alert? If not, we tighten the 2-room band.

### C. Customer form, multi-room line item (p19) — detector now exists

Her ask: drop the surface fields and leave only the notes area.

**She already answered the fallback herself** — "This is an ask/not required –
as a fallback, leave the field without a text template: list the rooms + their
surfaces in the color notes field as a template for the customer to fill in",
with a worked example:

```
Primary Bedroom
Walls:
Ceiling:
Trim:

Bedroom 2
Accent Wall:

Upstairs Hallway
Walls:

Bathroom
Ceiling:
```

So the fallback is pre-authorized and needs no further decision. It depends on
the same detector as B, which now exists (`lib/supplier-order/multi-room.ts`),
so this is buildable without asking anyone.

### D. Clipboard paste into Gmail (p21)

**Needs Kate.** No `mailto:` and no encoding step exists anywhere in the order
flow, so we cannot reproduce it. A screenshot of the bad paste and which button
she pressed would settle it — percent-encoding on paste usually means the copy
came from a URL rather than from page text.

---

## Not Kate's — Katie's

**The default product line.** Kate (Slack, 2026-10-09): "I checked the system
for a default product line and don't see one yet." There is none, anywhere.
The one that existed was removed on **Katie item 14, 2026-09-08: "get rid of
default from the top of the form"**, because a single control was speaking for
a job mixing Ultra Spec and Regal; each color now carries its own product
line, which is what the vendor email prints per line.

Kate and Katie have now asked for opposite things three times on this screen —
the line-items panel, the product-line default, and reachability versus clutter
on the order button. Worth settling who owns materials-ordering UX rather than
answering a fourth.
