# Hatch parity — every behaviour in their prompt, checked against ours

Built 2026-09-26 by walking Hatch's live prompt clause by clause and looking
for each behaviour in `lib/messaging/`. Source:
`HATCH_LIVE_PROMPT_2026_09_26.md`.

This is the agenda for the full-day walkthrough. **Anything found on the day
should land here and then become a scenario in `verify-scenarios-e2e.mjs`**,
so the day's findings run in seconds forever instead of evaporating.

Legend: ✅ we do it · ⚠️ partial · ❌ missing · 🟩 we are deliberately better

> **2026-09-26: gaps 2, 3 and 4 are built** — the three most likely to produce
> a visibly wrong message. The wording for 3 is OURS, not Hatch's, because
> Hatch contradicts itself on the hours (prompt says the latest slot is 5 PM,
> its own FAQ says 6 PM). `FIRST_SLOT_HOUR` and `LAST_SLOT_HOUR` are named
> constants in one place, so Kate's answer is a one-line edit.

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

### ✅ 1. Availability phrasing is day-dependent — BUILT 2026-09-26

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

### ✅ 2. A specific in-hours time gets a holding answer — BUILT 2026-09-26

> If they ask for a specific time within business hours → do not restate or
> confirm their time → reply **"I'll check the calendar for that time."** →
> continue the flow

We have no equivalent. A customer who says "how about Tuesday at 2?" currently
gets whatever the model picks. This is the single most likely place for an
A15 breach, because the natural reply is to confirm the time.

### ✅ 3. Out-of-hours appointment requests get a specific redirect — BUILT 2026-09-26

> Before hours: *"Our earliest slot is usually 10 AM, but if you need
> something earlier or on Saturday, I can check for you. What works best?"*
> After hours: *"Our latest slot is usually 5 PM, but if you need something
> later or on Saturday, I can check for you. What works best?"*
> Both: "Do not restate or confirm their time. Don't thank them."

Missing entirely. Note the FAQ contradicts the prompt here — the FAQ says
latest is **6 PM**, the prompt says **5 PM**. Do not copy either until Kate
settles it (QUESTIONS_FOR_KATE item 3).

### ✅ 4. AM/PM disambiguation — BUILT 2026-09-26

A bare "2" or "10" is ambiguous. Hatch resolves it. We do not, so a customer
saying "3 works" could be read as 3 AM by anything downstream.

### ✅ 5. Insisting on our availability first ends the conversation — BUILT 2026-09-26

> "If they insist on knowing our availability before providing theirs → End:
> Schedule Follow Up"

We have no detection for this. Without it the bot can be pulled into a loop
where it asks for availability and the customer keeps asking back.

### ⚠️ 6. Multiple properties — GUARDED 2026-09-26, not fully tracked

> "Multiple properties: gather info for each property one at a time. Complete
> the full flow for the first, then repeat for the next. Contact info can be
> reused if it applies to both."

**BUILT:** the bot notices a second property, may ask for its address without
tripping the A13 held-field guard, and **cannot close as `success`** while a
property it was told about has no address.

**NOT BUILT:** per-property state. The record holds one address and one scope,
so "which of the two is this zip for" is not answerable from the schema. Doing
it properly needs a properties table and a stage machine that knows which one
it is on — a schema change, and an Iteration 2 shape.

That split is deliberate. The failure prevented is the expensive one: closing
a two-property job having collected one, which is lost silently because the
conversation looks complete. Asking twice is merely untidy.

### ✅ 7. The returning-customer carve-out — BUILT 2026-09-26

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

### ✅ 9. Knowledge/FAQ store — CLOSED 2026-09-28

Hatch has ~25 curated Q&As per workspace (All Zips, Services/Surfaces, EPA,
payment terms, references, warranty, insurance…). Ours answered from the rules
plus the services table only, and a question outside that got `escalate`.

**Built, and proven end to end in the sandbox.** Settings → the workspace →
"What it can answer on its own". Each answer is checked on save against A1
(never a price) and A18 (never name another company), by the same pure
function the prompt build uses at read time.

Watch out for two things:

- **A save is not instant.** The prompt build caches for five minutes per
  server process, so an edit reaches the bot within about that and not on the
  next message. The screen says so; somebody testing thirty seconds later
  would otherwise conclude it does not work.
- **The sandbox must have the workspace selected** in "Answer as". With
  "Default settings" there is no workspace, so there are no standing answers
  and the bot escalates exactly as it did before. That is correct behaviour
  and looks identical to the feature being broken.

Verified: with the workspace selected, "do you guys have a minimum job size?"
was answered from the stored row and the flow carried on to the next step; the
same question with no workspace selected got "I'm not sure on that one".

**Still empty.** The table holds nothing — the ~25 answers per workspace are
Kate's to write, and there are 15 workspaces. That is the remaining work on
this gap, and it is content rather than code.

---

## Product gaps outside the conversation

| Gap | Note |
|---|---|
| ⚠️ **Voice** | **Call forwarding BUILT and EXERCISED 2026-09-26** — Kate moved it into Iteration 1. Signed request dials the call centre with the customer as caller ID; unsigned gets a spoken fallback, not a 403. Hatch forwards every workspace to (877) 645-3563 (checked on CA LA, CA San Diego, CO Denver), so `call_forward_to` stays NULL and the fallback matches. Voicemail greetings and inbound-call AI agents are still absent and were not asked for. |
| ❌ Containment / Bookable-to-Booked metrics | columns exist in Hatch (unpopulated), absent in ours |
| ❌ Snippet library | reusable named responses for reps |
| ❌ `[[[[Next Open Time]]]]` merge field | ours is static after-hours text |
| ❌ During/after-hours campaign copy | a step can carry two variants |
| ❌ Account-level setting inheritance | 32 workspaces each edited individually here |
| ⚠️ Campaign designer | theirs has a 30-day rail showing which days carry SMS vs email; ours is a list |
| ❌ **The sequence itself is half as long** | see below — four touches against Hatch's eight |

### The Leads Master Campaign stops on day 3; Hatch's runs to day 5

Read off the Automations screen on 2026-09-27 and set against the live Hatch
sequence captured in HATCH_LIVE_PROMPT_2026_09_26.md:

| | Ours | Hatch (SF Leads Campaign, CA LA) |
|---|---|---|
| Launch | SMS, then email **30 min** later | SMS (1 min delay), email **15 min** later |
| Day 2 | SMS 10:00 am | SMS **10:00 am**, SMS **6:30 pm** |
| Day 3 | SMS 10:00 am | email **9:00 am**, SMS **11:15 am** |
| Day 4 | — | SMS |
| Day 5 | — | SMS |
| Total | **4 touches** | **8 touches** |

Not a code gap: the sequence is editable on the Automations screen, so this is
a decision and a few minutes of typing. But it is worth deciding BEFORE launch
rather than discovering it in the conversion numbers — a lead that would have
answered on day 4 never hears from us, and that is invisible in every report
because nothing was sent to measure.

**→ For Karan and PPP:** does the Iteration 1 campaign intend Hatch's cadence
or the shorter one? The spec's "10 AM / 3 PM / 6 PM" is about the STALL
cadence, which is a different mechanism and already built — it does not settle
this.

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

---

## Gap 10 — the customer's NAME is still kept nowhere (open, 2026-09-28)

`sms_conversations.customer_name` is written once at enrolment and never
again — the same hole `inquiry_scope`, `customer_address` and (as of
2026-09-28) `customer_email` each had. All three of those are now captured
from the thread. **The name is not**, deliberately.

The bot asks for both at once — *"Can I grab your name and email for the
quote?"* — so a customer answering "Tom Smith, tom@example.com" now has the
email kept and the name dropped.

**Why it was left:** an email is unambiguous and machine-checkable; a name is
a judgement. "Tom Smith, tom@example.com" is easy, but "it's for my mother
Jane", "Tom at number 12" and "Mrs. Rodriguez — her son is calling" are not,
and a wrong name is worse than no name: it goes into `Hi {{customer_name}}`
and the customer is greeted as somebody else on every later message.

**What it costs today:** the merge field falls back, so greetings stay
generic. It does NOT block the close — A3's contact leg reads email or phone,
and the phone is always held.

**The decision needed:** either
(a) capture only the high-confidence shape — a name immediately beside the
    email in a reply to `ask_contact`, nothing else — and leave the rest to a
    person; or
(b) have the office fill it, and accept generic greetings from the bot.

Kate's call, because it is about what a customer gets called. Worth putting
to her alongside items 6 and 9.
