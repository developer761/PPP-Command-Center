# Questions for Kate — ask all at once

Karan's call, 2026-09-26: hold these and put them to Kate in one go rather
than one at a time.

**Nothing here is blocking.** Every item has a decision already made and
shipped, chosen to be the safe or the conservative reading. Each entry says
what we do today and what would change if she says otherwise, so she can
answer fast and nothing has to wait on her.

## The five that actually need her

Eleven were raised; the Iteration 1 spec closed five of them and one turned
out to be PPP's commercial call, not a rules question. What is genuinely left:

| # | Question | Weight |
|---|---|---|
| **5** | **What a park defaults to when no time is named** | **BLOCKING** — the spec says "do not pick one", so parking cannot ship without it |
| 2 | A3 and A6 contradict each other on "tenant" | Real conflict between two live rules; it changes routing |
| 9 | A46's approved strings are English only | A30 says we answer Spanish; A46 says never deny being a bot |
| 10 | Which closing lines come out of A44 | `schedule_follow_up` is also A40's park and A25's phone branch |
| 4 | A25's corrective_action contradicts her own rule card | Data tidy-up; it is what the rater grades against |

Only **5** stops work. The other four have a shipped default and can be
answered whenever.

---

**Every question carries a recommendation.** Karan, 2026-09-26: each one
should say what we think, not just what we are unsure about. So each item has
a **→ Recommendation** line giving the answer we would pick and why. Where we
have already shipped that answer, it says so — she is confirming a decision,
not making one from scratch, which is faster for her and safer for us.

Add to this file as more come up. Delete an item only once she has answered
and the answer is in the code.

---

## 1. ~~A45 and A46 are not in the rules file~~ — CLOSED, no need to ask

> **Closed 2026-09-26.** We created both rows from the spec's own text; the Rule Hub now lists **37 live rules**, which is its acceptance criterion. Her file overwriting ours later is a tidy-up, not a question.

<details><summary>original question, kept for the record</summary>



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

**→ Recommendation:** send us the two rows. We are building A45 and A46 from
the spec text either way, so nothing waits — but the Rule Hub's own acceptance
criterion is "all 37 live rules are listed" and we can only show 35 until the
rows exist. Two rows, and the screen matches the spec.

> **PARTLY CLOSED 2026-09-26.** The Iteration 1 Build Spec supplies **A46's
> two approved strings verbatim**, described as "approved final text — build
> against them byte for byte, straight apostrophes included". So A46 is no
> longer blocked; only the rule ROW is missing from the CSV, which affects
> the Rule Hub's "37 live rules" count, not the build.
>
> A45 is likewise fully specified in the spec, with delivery "deliberately
> unspecified and not a blocker". Still blocked: nothing, for building.
> Still needed: the two rows, so the Rule Hub shows 37 rather than 35.
>
> **Context from Hatch, 2026-09-26.** A46 is genuinely new — there is no AI
> disclosure anywhere in Hatch's opener, prompt or FAQ. A45 ("pause/resume
> calling") sits next to real voice features Hatch has and we do not: Call
> Forwarding is ON to (877) 645-3563, voicemail greetings are configurable,
> and one of the three AI agent types is **Inbound Calls**. Worth confirming
> whether A45 means the Salesforce call cadence or Hatch's own call handling,
> because the second one has nowhere to live in Connect Hub today.

</details>

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

**→ Recommendation:** keep A6. It is the more specific rule, it owns the
routing, and Hatch's own prompt uses "tenant" residentially. If A3 is meant to
win, the cheaper fix is deleting "the tenants" from A3's list rather than
re-opening A6, because A6's sentence is doing real work elsewhere.

> **Evidence from Hatch, 2026-09-26.** Its live prompt uses the word
> residentially: *"waiting on my **spouse/tenant**"*, in the availability
> branch. That supports A6's reading.

---

## 3. ~~A36 — whose clock, and does it cover replies?~~ — CLOSED, no need to ask

> **Closed by the Iteration 1 spec.** It settles both halves: *"In hours is per customer, not per clock… Resolve against the recipient's own callable window"*, and SETTLED 25 SEP: *"The bot is not held back out of hours. It answers in a different voice."* That is what we built.

<details><summary>original question, kept for the record</summary>



> **Updated 2026-09-26 after reading Hatch.** Hatch configures business hours
> **per workspace** (CA LA Leads: Mon–Fri 9:00 AM–7:00 PM, Sat/Sun 9:30
> AM–4:30 PM), and its workspaces are geographic — so the workspace clock and
> the customer's region are usually the same thing there. A36's "9 AM–8 PM
> Eastern" looks like the **Eastern workspaces' setting**, not a global rule.
>
> Six different sets of hours now exist across Hatch and Kate's rules: callback
> 8 AM–6 PM, slots 10 AM–5 PM, bot-question 9–5 M–F/9–3 Sat, FAQ 10 AM–6 PM,
> A36's 9–8/9–5:30, and the per-workspace settings — which are the only ones
> actually enforced. **The sharper question is now: should A36 be read as
> per-workspace hours plus a customer-local floor?** That is what we
> implement, and it matches how Hatch is actually configured.
> See `HATCH_LIVE_PROMPT_2026_09_26.md`.

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

**→ Recommendation:** confirm both as built. The customer-clock resolution is
not optional — the old behaviour was a federal violation, not a preference —
and reading A36 as governing contact PPP initiates keeps Karan's 2026-09-22
after-hours decision intact. If she wants the stricter reading, that is a
one-line change we will make on her word.

</details>

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

**→ Recommendation:** update the column. The rule card is dated and explicit
and the corrective action is not, so the card is almost certainly current. We
have built no concealment. This is a tidy-up so the rater does not grade
against a line that contradicts the rule above it.

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

**→ Recommendation:** three days, then one re-open, then treat it as a stall.
Hatch simply ends with Schedule Follow Up and lets the cadence pick it up,
which is a usable default — but it never comes back, which is the half the
spec says has "never once happened". Three days is long enough not to nag
somebody waiting on a spouse and short enough that the lead is still warm.
**We have not built this and will not guess** — the spec says "do not pick
one", so parking ships without the no-time branch until she answers.

> **Hatch's answer, read 2026-09-26.** Its prompt already has A40 situation
> (1) almost word for word — *"If the customer explicitly says they do not
> know their availability or are waiting on someone else … Confirm their
> project details, full address, and contact info as usual. Skip asking
> availability. After confirming … → End: Schedule Follow Up."*
>
> So Hatch **ends with Schedule Follow Up and lets the cadence pick it up** —
> it does not hold a park open. That is a usable default if she wants one.

---

## 6. Sign-off on two pieces of wording

Both are live text a customer sees, and neither is quoted verbatim in her
rules — we wrote them from her descriptions.

### bot_suspected — "are you a bot?"

> "Good question. Let me get someone from our team to pick this up with you."

> **What Hatch answers today**, from its FAQ "Who am I talking to?":
> **"This is Emily with Precision Painting Plus."** No AI disclosure at all,
> and it reads as a person. Its prompt also splits the bot question into
> during- and outside-business-hours branches that **both do the same thing**,
> so a behaviour was either lost or never existed. This is precisely the gap
> A46 exists to close.

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

**→ Recommendation:** keep the discard line as it is, and REPLACE the
bot_suspected one — A46 has already done that, since its approved in-hours
string is now the answer to "are you a bot?". So this item is really just the
discard line needing a nod.

---

## 7. ~~A26 — is the photo ceiling still detection only?~~ — CLOSED, no need to ask

> **Not Kate's.** The spec files it under *OURS · COMMERCIAL*: reading images is metered spend and has never been sized against PPP's volume. It is Karan and PPP's decision, not a rules question.

<details><summary>original question, kept for the record</summary>



A26 today: "Detection is a build requirement; interpretation is not.
ACKNOWLEDGING IS ALL THIS RULE ASKS… Do not describe or price from it (the
capability ceiling grants detection, not interpretation)."

Karan has asked for more than that: a photo of cabinets should land as *"got
it, looks like you want cabinets painted"* rather than just *"thanks, got the
photos"*.

**What we do today:** acknowledgement only, per the rule as written.

> **Hatch agrees with the ceiling.** Its prompt: *"If they want to send
> photos: they may send them and you will forward them to the estimator once
> the appointment is booked."* Acknowledge and forward, never interpret.

**What we need:** whether she wants the ceiling lifted to light
interpretation, and if so how far — naming the subject is a much smaller step
than describing condition or implying scope, and only the first is safe
without pricing risk.

**→ Recommendation:** lift it to NAMING THE SUBJECT only — "looks like
cabinets" — and nothing about condition, extent or price. That is what Karan
asked for, it is a real improvement on "thanks, got the photos", and it cannot
drift into quoting. Blocked on PPP's own open item: per-image billing has not
been sized against volume, so detection ships first either way.

</details>

---

## 8. ~~A44's cadence~~ — CLOSED, no need to ask

> **Closed by the spec** — 10 AM / 3 PM / 6 PM customer-local, its own campaign. Already recorded below.

<details><summary>original question, kept for the record</summary>



Found 2026-09-26 by reading Hatch's live campaign.

Hatch runs **two separate cadences**, and they must not be merged:

1. **The campaign sequence** — outbound nurture, hand-tuned per day:
   Launch (SMS, then email 15 min later) · Day 2 SMS **10:00 am** and **6:30
   pm** · Day 3 email **9:00 am** and SMS **11:15 am** · Day 4 SMS · Day 5 SMS
2. **The Conversation Rule** — the bot's stall follow-up: **"Wait 5 hours / 1
   attempt / Stalled / Only in business hours"**

A44 is the second one. The Iteration 1 spec asks for **three follow-ups at 10
AM / 3 PM / 6 PM customer-local**, which is neither: it is a regularised
version of the campaign's times applied to the stall cadence.

> **CLOSED.** The Iteration 1 Build Spec settles it: **three follow-ups at
> 10 AM / 3 PM / 6 PM the customer's local time**, one a day, shifted by
> A36's outbound hours, run as **a campaign of its own** — and explicitly:
> "Not the campaign that already exists… leave those steps as they are."
>
> It also answers two things I had not asked: the ending change applies to
> `schedule_follow_up` **only** (bailout keeps its closing line and gets its
> own review against A17/A24), and **no closing line** goes to the customer
> at the end — both current lines are removed rather than reworded.
>
> Hatch's "wait 5 hours / 1 attempt" is the OLD behaviour being replaced,
> not a competing option. Nothing to ask.

</details>

---

## 9. A46's Spanish wording needs sign-off

A46 supplies two approved strings in English. A30 says we answer Spanish
ourselves, and A46 says the bot "never denies being a bot, **in any state**"
— so a Spanish speaker asking cannot be the one case that gets something
else.

**What we do today:** faithful translations, in the usted register the rest
of the Spanish templates use. **They are mine, not approved.**

> In hours: "Soy un asistente de inteligencia artificial, pero puedo tomar
> los detalles de su proyecto y coordinarle una cita con un estimador.
> ¿Prefiere hablar con alguien de nuestro equipo?"
>
> Out of hours: "Soy un asistente de inteligencia artificial, pero puedo
> tomar los detalles de su proyecto y pasarlos cuando abramos."

**What we need:** her wording, or a nod to these. Swapping them is a
two-line change.

**→ Recommendation:** use ours unless she has a preference. They are faithful
and in the usted register the rest of the Spanish templates use. The
alternative — leaving Spanish speakers without a disclosure — is the one thing
A46 forbids outright, so shipping ours beats waiting.

---

## 10. A44 — which closing lines come out?

The spec says: "Apply the ending change to `schedule_follow_up` only… No
closing line is sent to the customer at the end — **both lines in use today
come out, removed rather than reworded**."

`schedule_follow_up` has exactly two lines today, which is presumably the
pair meant:

> "No problem at all. I'll check back in with you later on."
> "Understood. I'll follow up with you down the line."

But that intent is **not only** the stall ending. It is also A40's park
ending and A25's phone branch, and in both of those a line is correct — the
customer said something and deserves an answer.

**What we do today:** the stall cadence ends with **no customer-facing
message at all** — only the resume-calling signal to the call centre, which
satisfies "no closing line" whichever reading is right. The two templates
stay, because removing them would silence A40 and A25 as well.

**What we need:** confirmation that "both lines come out" means *at the end
of a stalled cadence*, not *everywhere `schedule_follow_up` is used*.

**→ Recommendation:** read it as the stall ending only. The cadence already
ends with no customer-facing message, so we satisfy it either way; removing
the templates outright would silence A40's park and A25's phone branch, where
a line is correct and expected.

---

## 11. ~~What does a stall follow-up actually say?~~ — CLOSED, no need to ask

> **Closed.** The spec supplies no copy and leaves build detail to us; Karan chose an agent turn using conversation memory, which is what memory-first exists for. Built that way. Worth a sentence in the next update, not a question.

<details><summary>original question, kept for the record</summary>



A44 specifies the cadence exactly — three follow-ups, 10 AM / 3 PM / 6 PM
customer-local — but supplies **no copy**. Hatch had named snippets for this
("Follow-up Text #1/2/3", "Circling Back #1/2"), and the spec says the Hub
cadence "replaces the manual follow-up chase Niro runs by hand today".

Two ways to build it:

- **(a) A template per step.** Predictable, reviewable, three fixed strings.
  But it cannot mention what the conversation was actually about, so follow-up
  #2 to someone who gave us their address reads the same as #2 to someone who
  gave us nothing.
- **(b) An agent turn using conversation memory.** The bot picks up at the
  next outstanding thing — "still after that zip code when you get a chance" —
  in the same constrained intent-and-template system everything else uses, so
  it is not free text.

**→ Recommendation: (b), and Karan agrees.** Conversation memory is capability
one in the build order precisely because parking and stalling both "come back
to a conversation later and have to remember it". A follow-up that has
forgotten the conversation is the Hatch behaviour being replaced — it is the
first of the three structural failures on the spec's own front page.

**What we need:** a nod to (b), and whether the third follow-up should differ
in tone from the first two, since it is the last one before the lead goes back
to the phone team.

</details>

---

## Separately, for Katie (not Kate)

- **A25's call-cadence write.** Both no-call branches ask for the customer to
  come off the call cadence in Salesforce. Connect Hub does not write to
  Salesforce except the gated opt-out writeback, so the preference is recorded
  here and surfaced for a person. Needs either an approved write or an agreed
  manual step.
- `SF_OPTOUT_WRITEBACK` still off, pending her approval.
- Twilio environment variables still outstanding.
