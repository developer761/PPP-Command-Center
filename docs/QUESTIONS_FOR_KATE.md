# Questions for Kate — ask all at once

Karan's call, 2026-09-26: hold these and put them to Kate in one go rather
than one at a time.

**Nothing here is blocking.** Every item has a decision already made and
shipped, chosen to be the safe or the conservative reading. Each entry says
what we do today and what would change if she says otherwise, so she can
answer fast and nothing has to wait on her.

Add to this file as more come up. Delete an item only once she has answered
and the answer is in the code.

---

## 1. A45 and A46 are not in the rules file · **needs a file from her**

The export she sent (`2026-09-25 hatch RULES.csv`) stops at A44. Confirmed
against the database: 44 rules, A1 to A44, nothing above it.

The Iteration 1 Build Spec asks for two capabilities numbered past that:

- **A45 — pause/resume calling**, two call-centre notifications
- **A46 — AI disclosure**, where the spec supplies both approved strings

**What we do today:** neither is built. A46's strings exist only in the spec
document, not in a rule row, so there is nothing for the rules screen or the
rater to grade against.

**What we need:** a RULES.csv that includes A45 and A46, or confirmation that
the spec text is the final wording and we should create the rows ourselves.

---

## 2. A3 and A6 contradict each other on the word "tenant" · **real conflict**

This is the one that could not be reconciled from the text. Both rules are
live, and they say opposite things about the same word.

**A3** lists it as establishing commercial:

> "…it is USUALLY PLAIN FROM WHAT THE CUSTOMER ALREADY SAID… 'We're a
> dentist's office', 'our store', **'the tenants'**, 'our building', 'the
> office', 'the restaurant' all establish it"

**A6** forbids exactly that:

> "THE TRIGGER IS THE SPACE, NEVER THE BUILDING. The words 'co-op', 'condo',
> **'tenant'** and 'apartment' DO NOT fire this gate and must never be
> treated as commercial signals — they describe where someone lives. Only a
> NAMED SHARED SPACE does: the lobby, the common areas, the corridors, the
> stairwells, the whole floor."

**It matters because A6 routes commercial work onsite.** Reading "the tenants"
as commercial sends a residential job to an onsite visit it does not need.

**What we do today:** we follow **A6**. `NOT_COMMERCIAL` in `offsite.ts`
excludes co-op, condo, tenant and apartment, and only a named shared space
fires the gate. A6 is the more specific rule and it is the one that owns the
routing, so it wins on both counts — but it is a guess about which she meant.

**If she says A3 wins:** "the tenants" starts routing onsite, and A6's
never-treat-as-commercial list loses one word.

---

## 3. A36 — whose clock, and does it cover replies? · **two parts**

### 3a. Confirm the window resolves against the CUSTOMER's zone

A36 is written in Eastern and names per-state behaviour. We read it as two
windows that must both be open: PPP's office (9–8 ET weekdays, 9–5:30 at
weekends) and the customer's own 9–7 on their own clock.

**Worth her knowing this was not only a spec gap.** The gate previously read
the *workspace's* clock, so at 9:30am Eastern it would have texted a
California number at **6:30 in the morning** — under the federal 8am floor.
That is fixed.

**What we do today:** the recipient's zone resolves from their zip through
PPP's territory table, then their area code, and when neither answers, the
most restrictive zone PPP serves. Never the sender's.

**Checks out against her own acceptance test:** at 7:30pm Eastern the
California lead gets the send and the Eastern lead does not, on the same
clock tick.

### 3b. Does the window cover replies to an inbound, or only outbound we start?

A36 says "Any OUTBOUND message the bot sends obeys these hours", but it also
names itself "CALLBACK WINDOW **to SET an appointment**".

**What we do today:** we read it as governing contact **PPP initiates**.
Somebody who texts at 8:30pm has started the conversation, and answering them
is not a callback to set an appointment. This preserves Karan's 2026-09-22
decision on after-hours replies.

The customer's federal 8am–9pm window still applies to those replies on their
own clock — only PPP's office window stands down.

**If she means the stricter reading:** a customer texting at 8:30pm gets no
answer until the next morning. One line changes, and four tests with it.

---

## 4. A25's corrective action contradicts her own later note · **stale column**

The rule card, dated:

> "🔴 CONCEALING THE HANDOFF IS NOT REQUIRED (Kate, 2026-09-18). 'Without the
> customer knowing' was a HATCH guard, not a business rule… **Do not write
> concealment into any rule, and never tag a bot for failing to conceal a
> handoff.**"

The `corrective_action` column on the same rule still reads:

> "…captured their callback time preference and **made a silent transfer** to
> a human"

**What we do today:** we treat the rule card as current, because it is dated
and explicit, and we build no concealment. The bot says it is bringing someone
in.

**What we need:** the column updated, or confirmation that "silent transfer"
means something narrower than concealment (e.g. no carrier-visible system
message) and the two are not actually in conflict.

---

## 5. A40 — what to do when they park without naming a time

A40's parking branch: the customer defers the conversation itself and we stop
asking and wait for them.

Where they name a time ("call me after the 15th"), the thread re-opens then.

**Open:** what happens when they park and name **no** time. Waiting forever
means the lead dies silently; picking a number ourselves invents a cadence she
did not ask for, and A44 explicitly says a park is not a stall.

**What we do today:** not built. A40's parking branch is the next thing being
built, and this is the one decision inside it that is hers, not ours.

**What we need:** a fallback interval, or a rule that says no-time parks are
handed to a person rather than re-opened by the bot.

---

## 6. Sign-off on two pieces of wording

Both are live text a customer sees, and neither is quoted verbatim in her
rules — we wrote them from her descriptions.

### bot_suspected — "are you a bot?"

> "Good question. Let me get someone from our team to pick this up with you."

Deliberately neither confirms nor denies. Somebody told "yes, a real person"
has been deceived, and it is the sort of thing that ends up in a screenshot.

**This overlaps A46.** If A46's approved disclosure strings are meant to be
the answer here, this template should be replaced by one of them rather than
sitting alongside them. Worth deciding the two together.

### discard — work we do not do

> "Thanks for reaching out! That isn't something we're able to take on. If
> I've misread the project, let me know and I'll take another look."

Her wording turned into a sentence: say we cannot help, invite the correction,
never point them at another company (A18).

---

## 7. A26 — is the photo ceiling still detection only?

A26 today: "Detection is a build requirement; interpretation is not.
ACKNOWLEDGING IS ALL THIS RULE ASKS… Do not describe or price from it (the
capability ceiling grants detection, not interpretation)."

Karan has asked for more than that: a photo of cabinets should land as *"got
it, looks like you want cabinets painted"* rather than just *"thanks, got the
photos"*.

**What we do today:** acknowledgement only, per the rule as written.

**What we need:** whether she wants the ceiling lifted to light
interpretation, and if so how far — naming the subject is a much smaller step
than describing condition or implying scope, and only the first is safe
without pricing risk.

---

## Separately, for Katie (not Kate)

- **A25's call-cadence write.** Both no-call branches ask for the customer to
  come off the call cadence in Salesforce. Connect Hub does not write to
  Salesforce except the gated opt-out writeback, so the preference is recorded
  here and surfaced for a person. Needs either an approved write or an agreed
  manual step.
- `SF_OPTOUT_WRITEBACK` still off, pending her approval.
- Twilio environment variables still outstanding.
