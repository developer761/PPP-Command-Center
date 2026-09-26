# Hatch parity — every behaviour in their prompt, checked against ours

Built 2026-09-26 by walking Hatch's live prompt clause by clause and looking
for each behaviour in `lib/messaging/`. Source:
`HATCH_LIVE_PROMPT_2026_09_26.md`.

This is the agenda for the full-day walkthrough. **Anything found on the day
should land here and then become a scenario in `verify-scenarios-e2e.mjs`**,
so the day's findings run in seconds forever instead of evaporating.

Legend: ✅ we do it · ⚠️ partial · ❌ missing · 🟩 we are deliberately better

---

## Correctness and compliance — we are ahead

| Behaviour | Hatch | Connect Hub |
|---|---|---|
| Sending hours | per workspace only, no recipient floor | 🟩 recipient's own federal window, proved over 1,210 instants |
| Quiet-hours enforcement | prompt instruction | 🟩 `gatedSend`, uncircumventable |
| Suppression list | not visible in product | 🟩 31,601 rows, port rail refuses sends while empty |
| Never quote a price | prompt instruction | 🟩 `quoted_a_price` validator reject |
| Never invent availability | prompt instruction | 🟩 `invented_availability` validator reject |
| One ask per message | prompt instruction | 🟩 `tooManyAsks` |
| Opt-out disclosure | typed into campaign copy | 🟩 appended at the gate, cannot be deleted |
| Rule consistency | six different sets of hours | 🟩 one window rule, one implementation |

Everything in that column was an *instruction to a model* in Hatch and is a
*refusal in code* here. That is the substantive difference and it is the
reason to replace them.

---

## Behaviours Hatch has that we do NOT — ordered by how much they matter

### ❌ 1. Availability phrasing is day-dependent

> Sunday–Wednesday: *"We have a few openings **this week** to meet with you,
> what would work best for you?"*
> Thursday–Saturday: *"We have a few openings **next week** to meet with you,
> what would work best for you?"*

Ours is generic: *"What days generally work best for you?"*

Hatch's version sets an expectation and creates mild urgency; ours asks an
open question that invites "sometime next month". **Worth copying**, and it is
a template change plus a day-of-week read, so it is cheap.

Note it is approved copy that names a *rough* window without naming a time,
which stays inside A15 and our `invented_availability` guard.

### ❌ 2. A specific in-hours time gets a holding answer

> If they ask for a specific time within business hours → do not restate or
> confirm their time → reply **"I'll check the calendar for that time."** →
> continue the flow

We have no equivalent. A customer who says "how about Tuesday at 2?" currently
gets whatever the model picks. This is the single most likely place for an
A15 breach, because the natural reply is to confirm the time.

### ❌ 3. Out-of-hours appointment requests get a specific redirect

> Before hours: *"Our earliest slot is usually 10 AM, but if you need
> something earlier or on Saturday, I can check for you. What works best?"*
> After hours: *"Our latest slot is usually 5 PM, but if you need something
> later or on Saturday, I can check for you. What works best?"*
> Both: "Do not restate or confirm their time. Don't thank them."

Missing entirely. Note the FAQ contradicts the prompt here — the FAQ says
latest is **6 PM**, the prompt says **5 PM**. Do not copy either until Kate
settles it (QUESTIONS_FOR_KATE item 3).

### ❌ 4. "Assume times between 8 and 11 are AM and 12 to 7 are PM"

A bare "2" or "10" is ambiguous. Hatch resolves it. We do not, so a customer
saying "3 works" could be read as 3 AM by anything downstream.

### ❌ 5. Insisting on our availability first ends the conversation

> "If they insist on knowing our availability before providing theirs → End:
> Schedule Follow Up"

We have no detection for this. Without it the bot can be pulled into a loop
where it asks for availability and the customer keeps asking back.

### ❌ 6. Multiple properties, one at a time

> "Multiple properties: gather info for each property one at a time. Complete
> the full flow for the first, then repeat for the next. Contact info can be
> reused if it applies to both."

Nothing in our flow handles a second property. Our stage machine assumes one
job per conversation. **This is the largest structural gap on the list** and
is not a template change.

### ❌ 7. The returning-customer carve-out

> "If they don't want to provide their information since they have worked
> with us before, thank them for considering us for their new project and let
> them know we like to doublecheck that everything is still accurate… Ask if
> they'd mind confirming their address, **but move on if they don't provide
> it.**"

We would keep asking. A3's legs are satisfied by having *asked*, so this may
already be tolerable, but the "move on" behaviour is not explicit.

### ❌ 8. Standing answers we do not hold

- Where we are located — *"We serve the majority of the greater Los Angeles
  and Orange County area."* (per workspace)
- Where the office is — *Pasadena* (per workspace)
- "If they could not find our phone online: provide Emily's direct number and
  note you will share the estimator's direct number once booked."

These live in Hatch's FAQ/Knowledge per workspace. We have no per-workspace
FAQ store at all, which is also gap 9.

### ❌ 9. No Knowledge/FAQ store

Hatch has ~25 curated Q&As per workspace (All Zips, Services/Surfaces, EPA,
payment terms, references, warranty, insurance…). Ours answers from the rules
plus the services table only. A question outside that gets `escalate`.

---

## Product gaps outside the conversation

| Gap | Note |
|---|---|
| ❌ **Voice** | call forwarding, voicemail, inbound-call agents, Voice reporting. **Scope decision for Karan/PPP** |
| ❌ Containment / Bookable-to-Booked metrics | columns exist in Hatch (unpopulated), absent in ours |
| ❌ Snippet library | reusable named responses for reps |
| ❌ `[[[[Next Open Time]]]]` merge field | ours is static after-hours text |
| ❌ During/after-hours campaign copy | a step can carry two variants |
| ❌ Account-level setting inheritance | 32 workspaces each edited individually here |
| ⚠️ Campaign designer | theirs has a 30-day rail showing which days carry SMS vs email; ours is a list |

---

## Things we match

✅ Flexible availability ("anytime", "I'm flexible") counts as **received**,
not as "doesn't know" — `OPEN_ENDED` in `availability.ts`, and Hatch's rule is
identical.
✅ Photos: acknowledge and forward, never interpret (A26).
✅ Off-site quote suggest-vs-require triggers and the guardrail that all three
fields are still owed.
✅ Required order: project details → address → contact → availability.
✅ Tone rules — no "Yep", no em dashes, no ellipsis, no parentheses, no
"Thanks for letting me know".
✅ Never point a customer at another company (A18).
✅ A40 parking, both branches (shipped 2026-09-26).
✅ A25 channel preference — and ours is **correct where Hatch is wrong**: it
ends both branches, which Kate calls the defect.

---

## Suggested order for the walkthrough day

1. **Gaps 2, 3, 4** together — all appointment-time handling, all likely A15
   breaches, all cheap. One session.
2. **Gap 1** — availability phrasing. Template + day read.
3. **Gap 5** — the availability stand-off.
4. **Gap 7** — returning customer.
5. **Gap 6** — multiple properties. Structural; may deserve its own day.
6. **Gaps 8/9** — a per-workspace FAQ store. Also structural.

Gaps 2, 3 and 4 are the ones most likely to produce a visibly wrong message
to a real customer, so they go first.
