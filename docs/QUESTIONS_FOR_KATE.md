# Questions for Kate — ask all at once

> ## Her answers, 2026-09-28
>
> Three name their subject unmistakably and are recorded on the items below —
> **2** (follow A6, drop "tenants" from A3), **10** (the A44 ending), and
> **4** (A25's callback cadence, change type WORDING).
>
> **The two "Checking with Mac/Jasmine" replies landed later the same day**,
> and were items **5** (the park default — the one she called blocking) and
> **9** (A46's Spanish). Both are now answered and both are built:
>
> - **5** — parks get their own cadence, 3/6/9 days rather than the stall's
>   1/2/3. Two of her three park cases are still open and are written up on
>   the item; neither is guessed at.
> - **9** — Mac and Jasmine asked for **no inverted punctuation** in Spanish.
>   Not a typographic preference: they said `¿` reads as a flag that the
>   customer is not talking to a Spanish speaker. Stripped from every outbound
>   string and from the prompt, with the inbound detection left alone — a
>   customer writing "¿Cuánto cuesta?" is still how we know to answer in
>   Spanish.
>
> This supersedes Karan's earlier "the spanish we cna keep it doesnt hurt":
> that was about the register, before Mac and Jasmine's specific note arrived.
>
> Separate threads: **Voice** — answered Saturday. **Photos** — roughly 125 a
> month, tracked only since the start of June, so that is one quarter's
> evidence rather than a year's.

Karan's call, 2026-09-26: hold these and put them to Kate in one go rather
than one at a time.

**Nothing here is blocking.** Every item has a decision already made and
shipped, chosen to be the safe or the conservative reading. Each entry says
what we do today and what would change if she says otherwise, so she can
answer fast and nothing has to wait on her.

## What is actually left — updated 2026-09-28

All five she was asked are **answered**, and the answers are built. This table
was stale for a day and cost real time working out which reply belonged to
which item, so it is now kept current rather than as a record of the original
ask.

| # | Question | State |
|---|---|---|
| 5 | What a park defaults to when no time is named | **ANSWERED** — park cadence built; two sub-cases still open, see the item |
| 2 | A3 and A6 contradict each other on "tenant" | **ANSWERED and DONE** — her reissued sheet fixed it at source; imported 2026-09-28 |
| 9 | A46's approved strings are English only | **ANSWERED** — no inverted punctuation; built |
| 10 | Which closing lines come out of A44 | **ANSWERED** — our ending confirmed; follow-up wording waits on her copy |
| 4 | A25's corrective_action contradicts her own rule card | **ANSWERED** — we had the handoff backwards; rebuilt |

**Open, and waiting on her:** the A7 note behind the two-week event park (5),
the final follow-up verbiage (10), the bare "our building" — now answered,
see item 2 — plus 13 and 14, which were never in this five.

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

## 2. A3 and A6 contradict each other on "tenant" — **ANSWERED 2026-09-28**

> **Kate, 2026-09-28:** *"Yes, follow A6 + remove 'tenants' from A3"*
>
> **The code was already right.** `offsite.ts` follows A6 and says so in a
> comment — NOT_COMMERCIAL is a veto, so "the tenants in our building" does
> not route commercial. Nothing to change there.
>
> **The rule text is not.** Both cards still reach the model in the same
> prompt, every turn, so the bot reads a contradiction:
>
> - **A3**: *"…'our store', **'the tenants'**, 'our building'… all establish it"*
> - **A6**: *"The words 'co-op', 'condo', **'tenant'** and 'apartment' DO NOT
>   fire this gate and must never be treated as commercial signals"*
>
> **DONE — and not the way this originally said.** There was a SQL statement
> here for Karan to run. It is deleted and must not be run: Kate reissued the
> sheet the same evening, and her A3 does more than remove the phrase. It adds
> what a REPLACE could never have written:
>
> *"THE WORD 'TENANT' DOES NOT ESTABLISH IT and must never be read as a
> commercial signal here - a landlord describing work in a tenant's unit is
> residential. A6 holds the full carve-out; read this list as consistent with
> it, never against it."*
>
> Imported 2026-09-28 with `npm run import:rules`. The contradiction is gone
> at source rather than patched, and because it came from her sheet it will
> survive the next re-import — which the hand-written patch would not have.

<details><summary>the original question, kept for the record</summary>

> **MOSTLY CLOSED 2026-09-27.** The precedence is settled inside the rules;
> one narrower sub-case is flagged below with a safe default already built.

The clash is real and both cards are dated the same day, 2026-09-25:

- **A3** [3]: *"'We're a dentist's office', 'our store', **'the tenants'**,
  'our building' … all establish it"*
- **A6** [6]: *"The words 'co-op', 'condo', **'tenant'** and 'apartment' DO NOT
  fire this gate and **must never** be treated as commercial signals — they
  describe where someone lives. Only a NAMED SHARED SPACE does."*

**A3's own 2026-09-25 revision resolves it.** Its card gained: *"PROJECT
DETAILS MEANS WHAT A6 NEEDS TO ROUTE THE JOB … the moment the lookup CAN be
resolved, **A6 takes over**."* A3 subordinates itself to A6 on routing, and A6
states its half as a never. So **A6 wins** and "the tenants" in A3's list is a
drafting leftover. That is what is built.

**What tracing it turned up.** `NOT_COMMERCIAL` — the regex naming exactly
those residential words — was declared in `offsite.ts` and **referenced
nowhere**, so A6's "never" enforced nothing. A landlord writing *"the tenants
in our building are complaining"* matched "our building" and routed the job
commercial. Now a real branch, with a named shared space still winning over it
("our building's lobby" is commercial; "my condo living room" is not).

**The one sub-case left, and we have NOT guessed.** A bare *"our building"*,
with no residential word and no named space, still routes commercial. A3 lists
it, A6's "never the building" excludes it, and the two errors are not
symmetrical: reading it as commercial costs an estimator visit, reading it as
residential can send a commercial job down a path A6 says must never price it.
We kept the safe side.

**→ Confirm only this:** should a bare "our building" route commercial? We say
yes, on the cost of being wrong. Everything else in item 2 is settled.

</details>

> **The bare "our building" sub-case is ANSWERED too**, 2026-09-28:
>
> *"Yes, I'd say that's a good indicator for commercial or a project the guys
> should see in person!"*
>
> Which is what we built, and her phrasing is worth keeping: the outcome she
> cares about is **someone seeing it in person**, with "commercial" being one
> route to that rather than the point in itself. `isCommercial` returning true
> sends it onsite, so the label and the outcome agree here — but if the two
> ever come apart, in person is the half to preserve.

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

## 4. A25's corrective action contradicts her own later note — **ANSWERED 2026-09-28**

> **Kate, 2026-09-28**, change type **WORDING**:
>
> *"the silent transfer aspect is to ensure the cadence is: customer states
> they want to continue booking convo via call rather than text/email > bot
> captures the call back time > if call back time is within business hours,
> state 'we will reach out then', if call back time is outside of business
> hours, state business hours + ask if there is a time that works for them
> within that timeframe. Once call back time is captured, a reply to the
> customer is valid stating 'We will reach out then' or something similar,
> then transfer the conversation to a human to place the call. Silent transfer
> is not the right term, we essentially don't want the bot to say 'I'll have a
> colleague/human reach out then'. We want it to be a seamless transition."*
>
> **This is the opposite of what we had built, and our recommendation below
> was wrong.** We read "concealing the handoff is not required" as licence to
> narrate it, and shipped *"I'll have someone from the office give you a
> call."* She is not asking us to conceal anything — she is asking the bot to
> speak as PPP rather than as a bot handing off. "We will reach out then" is
> the business talking; "I'll get someone on our team to call you" exposes a
> seam the customer has no use for.
>
> Two changes follow, and the second is new behaviour rather than wording:
>
> 1. the two phone-branch variants stop naming a someone;
> 2. the captured callback time is checked against the office window — inside
>    it, "we will reach out then"; outside it, state the hours and ask for a
>    time within them.
>
> Both shipped 2026-09-28. The rule card and the corrective_action column are
> no longer in conflict once read her way: not concealment, just one voice.

<details><summary>the original question, kept for the record</summary>

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

</details>

---

## 5. A40 — what to park without naming a time — **ANSWERED 2026-09-28**

> **Kate, 2026-09-28.** This was the one item she called blocking.
>
> *"I think a parking cadence would make sense here because the CC has a
> varied approach and the stalled convo cadence wouldn't kick in on these."*
>
> She then splits parks into three, which we had been treating as one:
>
> | park | what she wants | built? |
> |---|---|---|
> | **Bare deferral** — "I'll get back to you", "once I've spoken to my wife", "not ready yet", "still deciding on scope" | follow up at **2-3 days, three times**, then tell the call centre it may resume calling | **YES, 2026-09-28** |
> | **Blocked on a named event** — moving, closing, insurance, no power, travelling | **2 weeks**; she notes this "is already covered by a rule you have" | **not yet** — see below |
> | **Explicitly asks us to stop chasing** | hand to the call centre | **not yet** |
>
> And on our proposal: *"Your 3 days was right for the first nudge; the change
> is not declaring a stall straight after it."*
>
> **What was wrong.** Both a stall and a park went down the same cadence —
> chased the next morning, then daily. Somebody who said "let me speak to my
> wife" got a nudge the following day, which is the rudeness A40 exists to
> prevent. The ending was already right: three messages, then the resume
> signal. Only the spacing was wrong.
>
> **Now:** a park is chased on day 3, 6 and 9 of the customer's calendar,
> against the stall's 1, 2, 3. Same three messages, same hours, same ending.
> Pinned with a wiring chain, because two cadences that differ only in spacing
> are exactly the kind of thing that reverts without anything looking broken.
>
> **Built 2026-09-28, after her fuller answer and the updated sheet:** all
> three park cases. Bare deferral 3/6/9 days; named event two weeks with A7
> run first; "don't chase me" gets no cadence and the call centre is told,
> with its own note rather than the cadence-spent one, which would have
> claimed we chased somebody who asked us not to.
>
> **One thing she did not say, and we did not invent:** how many nudges an
> EVENT park gets. She gives the wait ("TWO WEEKS") and not the count. Built
> as three with the first at a fortnight, because her framing is "the wait
> depends on WHY" — the alternative reading, three nudges a fortnight apart,
> chases somebody for six weeks. Worth one line from her.
>
> **Superseded:**
>
> 1. **The named-event park at 2 weeks.** She says a rule already covers it,
>    pointing at "the A7 note below" — we do not have that note, so we do not
>    know which rule she means. `parkReopenAt` already schedules a re-open
>    when a customer names a *day*, and MAX_PARK_DAYS is 120, so the mechanism
>    exists; what is missing is recognising "we're closing on the 14th" or
>    "once the insurance pays out" as a two-week park rather than a bare
>    deferral. **Ask her for the A7 note before building it.**
> 2. **"Stop chasing" → the call centre.** Today that reads as A17 and ends
>    the conversation rather than handing it on. Small, but it changes who
>    owns the lead, so it wants confirming alongside item 14, which is the
>    same question about a different phrasing.

<details><summary>our earlier reasoning, kept for the record</summary>

> **CLOSED 2026-09-27**, from Hatch's own configuration plus a defect we found
> tracing it. Kept here because the behaviour changed.

**What Hatch actually does**, read from its live prompt and Conversation Rule:
a no-time park ends as **Schedule Follow Up** and falls to the generic rule —
*"Wait 5 hours / 1 attempt / Stalled / Only in business hours."* It does not
invent a park-specific timer. One mechanism, not two.

**AND WE HAD REPRODUCED THE EXACT DEFECT A40 EXISTS TO FIX.** Tracing the
three functions together rather than separately:

| customer says | re-open scheduled | chased as stalled |
|---|---|---|
| "call me next Tuesday" | yes | no — the re-open owns it |
| "let me check with my wife" | **no** | **no** |
| "I'll reach out when I'm ready" | **no** | **no** |

`parkReopenAt` returns null when no day is named, so no reminder row is
written — and `schedule_follow_up` was in the stall sweep's PROPER_ENDINGS, so
the cadence skipped it too. Neither path owned the conversation. Kate's own
words for this: *"What has never once happened is the bot coming back."*

**What we do now:** an ending that promises a follow-up and schedules nothing
is not a proper ending. A park that named a day keeps its re-open; one that
scheduled nothing is picked up by the A44 cadence, which already exists,
already obeys A36's hours and already honours A24. No new timer, and the same
shape as Hatch.

**→ Nothing needed from her** unless she wants the no-time park to reach a
person instead of the cadence. Worth one line of confirmation, not a blocker.

</details>

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

## 6b. The availability ask no longer claims we have openings

**CHANGED 2026-09-27, and worth your eye on the wording.**

Parity gap 1 copied Hatch's sentence verbatim:

> "We have a few openings **this week** to meet with you, what would work best
> for you?"

It asserts something the bot cannot know. It has no calendar — the office owns
it, and the system prompt says so: *"You never quote a price and you never
offer an appointment time. The office does both."*

**The contradiction was total.** Our own validator refuses the MODEL for
writing that exact sentence:

```
invented_availability: free text names "this week" with no verified
availability behind it
```

The template sent it anyway, because templates do not go through the rapport
check. Found by reading an imported Hatch thread and recognising our own
wording inside it.

**Now:** "What days work best for you **this week**?" — the week anchor is the
part worth keeping, since parity gap 1 exists because the old open question
drifted. The week stays; the claim goes. Spanish likewise: *"¿Qué días le
vienen mejor esta semana?"*

**→ Recommendation:** keep the new wording. If PPP genuinely wants to offer
openings, that needs a real calendar behind it, which is an Iteration 2 shape.
A sweep now asserts that no template in either language claims an opening.

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

## 10. A44 — which closing lines come out? — **ANSWERED 2026-09-28**

> **Kate, 2026-09-28**, replacing the spec line quoted below:
>
> *"Once the three follow-ups are completed and the customer has not replied,
> the call center gets a notification to resume the call cadence. The verbiage
> used in the three follow-ups is following up on their request for their
> [SCOPE IF WE HAVE IT] project. Will iron out the exact verbiage before
> launch."*
>
> **Our ending is confirmed correct and nothing changes there.** The cadence
> already finishes with no customer-facing message and only the resume-calling
> signal to the call centre, which is exactly what she describes. The two
> `schedule_follow_up` templates stay, because the reading that would have
> removed them — "everywhere the intent is used" — is not the one she meant;
> her sentence is about the end of the cadence.
>
> **One thing is new, and it is not built:** the three follow-ups should say
> they are following up on the customer's request for their *[scope]* project.
> Ours are an agent turn over the conversation (item 11), and the scope is
> already in that prompt via `knownCustomerPrompt`, so the model *can* reach
> it — whether it reliably says it is a behaviour question nobody has checked.
>
> **Deliberately not built yet.** She says the exact verbiage is still to be
> ironed out before launch, and writing final copy against a line that is
> about to change is churn. What is worth doing when the copy lands: pin it
> with a wiring chain, because "the follow-up mentions the scope" is precisely
> the kind of rule that is written once and quietly stops firing.

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

## 12. ~~Two rules carry a date with no change type~~ — ANSWERED OURSELVES

> **CLOSED 2026-09-27** by reading the rules table. It is not a data-entry
> slip, and it is **three** rules, not two — my own note undercounted.

Every rule dated **2026-09-11** has no change type. Every rule dated
**2026-09-17 or later** has one. Forty-three to three, with no exceptions
either way:

| last_modified | rules | change type |
|---|---|---|
| 2026-09-11 | A28, A37, A38 | **none** |
| 2026-09-17 → 2026-09-25 | the other 43 | BINDING ×40, WORDING ×3 |

So `change_type` began with the 2026-09-17 pass. The three rules untouched
since 09-11 predate the column — there is no missing value to supply.

And **A37 is not a live rule at all**: `status: retired`, statement *"BURNED
2026-09-10 — never use this id."* A tombstone kept visible so the id is never
reused. It cannot have a change type.

**→ Nothing to ask.** The Rule Hub showing a date with no type for exactly
those rules is correct. If anything is worth doing it is ours: label them
"predates change tracking" so they do not read as missing data.

## 14. "Don't text me, just call me" is suppressed and the lead is closed

**OPEN.** Found in the simulator on 2026-09-27. Not a bug report — a policy
question, because every step is behaving as written.

    customer  "dont text me just call me"
    BOT       opted_out, 100%
              "(No reply is sent. The number is suppressed and nothing
               further can go out to it.)"

**Every part of that is correct on its own.** A24 says the opt-out wins even
when other content is packed into the same message, and "don't text me" IS a
revocation of consent for texts — suppressing is the legally safe reading, and
the classifier is right to take it.

**What happens next is the problem.** The number goes on the suppression list,
the conversation is ended as `discard`, and the call-pause signal is
deliberately skipped (correctly — you do not hand the call centre a "they are
in conversation" flag about somebody who opted out). So:

- nothing records that this customer asked to be **called**
- the conversation is closed, so it appears in no queue
- a person reviewing sees "opted out" and moves on

A customer who asked us to phone them is filed as somebody who asked us to go
away. These phrasings all land there — `"dont text me just call me"`,
`"don't text me, just call me"`, `"stop texting me and call me instead"` —
while `"please call me instead of texting"` is read correctly as A25.

**It gets worse if `SF_OPTOUT_WRITEBACK` is ever switched on.** That would mark
them opted-out in Salesforce, which is where the CALL cadence lives, so the one
channel they asked for would be shut off too.

**→ Recommendation:** keep the suppression exactly as it is, and stop closing
the conversation silently. A text-stop that also asks for a call should reach a
person — `customer_asked_human` already exists as a takeover reason and needs
no schema change. NOT changed unilaterally: it is a compliance path, and the
Salesforce interaction is Katie's call as much as yours.

---

## 13. Parity 7 — after one refusal, does "move on" mean stop asking?

**OPEN.** Raised by the persona hunt on 2026-09-27, not by Kate.

Hatch's own wording is *"Ask if they'd mind confirming their address, BUT MOVE
ON IF THEY DON'T PROVIDE IT."*

**What we do today:** the acknowledgement is sent **once**. A second refusal
gets the ordinary one-line ask instead of the same apologetic paragraph again
— which was the bug: it repeated every turn, nagging in the words of an
apology for nagging.

The open half is what "move on" means for the FLOW. Two readings:

1. **Ask once more, plainly** (what we do). A3 wants the leg asked, and its
   legs are satisfied by having asked rather than by holding a value, so the
   conversation still completes.
2. **Stop asking for that field entirely** and go straight to the next leg.
   Closer to the literal wording, but it changes what the bot collects, and on
   a returning customer whose address HAS changed we would book an estimator to
   the old one.

**→ Recommendation:** reading 1, which is what is built. It is the reversible
one, and the risk in reading 2 lands on the customer's driveway. Confirm and we
leave it; say otherwise and it is a one-line change in the validator.

---

## Separately, for Katie (not Kate)

- **A25's call-cadence write.** Both no-call branches ask for the customer to
  come off the call cadence in Salesforce. Connect Hub does not write to
  Salesforce except the gated opt-out writeback, so the preference is recorded
  here and surfaced for a person. Needs either an approved write or an agreed
  manual step.
- `SF_OPTOUT_WRITEBACK` still off, pending her approval.
- Twilio environment variables still outstanding.
- **Is downtown Denver really outside the Denver territory?** The service map
  holds 2,191 zips: NY 544, FL 401, NJ 379, CA 363, CT 145, TX 118, CO 88,
  LA 82, VA 36, NC 31, PA 2, MD 1, and one row with no state at all (59901,
  Kalispell MT). Colorado's 88 include 80206 and 80108 (both "CO Denver",
  active) but **not 80202**, which is downtown Denver.

  Nothing is broken by this — an unmatched zip answers `needs_a_person`, so
  the bot hands to a human rather than turning the customer away, which is
  the safe direction. But it means every downtown-Denver lead goes to a
  person, permanently, and it looks more like a gap in the import than a
  deliberate boundary.

  Two things to confirm: whether the CO list is complete, and what the
  state-less Kalispell row is doing there — Montana is not a state PPP
  serves, and with no state on the row it cannot be recognised as
  out-of-state either.

---

## 15. "Call me at 2pm" escalates, because the model repeats the time back

**OPEN — for Karan, not Kate.** Found in Chrome 2026-09-28 while testing the
new A25 cadence. **Pre-existing, not caused by that change**, and every step
is behaving as written.

    customer  "can you call me instead of texting? 2pm is good"
    BOT       rejected: invented_availability
              it chose schedule_follow_up and wrote: "Of course, 2pm works."

2pm is inside the callback window, so this is the *happy* path Kate just
specified — the template alone would have said **"No problem at all. We'll
reach out then."**, which is correct, complete and names no time. Instead the
model added the time in rapport, the guard refused the whole turn, and a good
lead went to a person.

**The guard is right and I have not touched it.** "A time is only allowed if
the system supplied it. The model offering one is how a customer ends up
waiting for an estimator who was never booked." That reasoning is about
INVENTING a slot. Here the model is echoing back the time the customer
themselves just named — which is not an invention, but the check cannot tell
the two apart, and every number a customer sees is supposed to come from a
template.

**Why I did not fix it unilaterally.** The obvious remedy is to DROP the
offending rapport rather than refuse the turn, exactly as a tone violation is
dropped today — the template underneath is already correct. But that is a
real loosening of a core safety property, on the one guard that stops the bot
promising appointments, and the current failure is safe: a handover, not a
wrong promise.

**→ Recommendation:** drop-not-refuse, narrowed to the case where the time in
the rapport is one the CUSTOMER named in the message being answered. That
keeps the guard fatal for an invented slot and merely silences an echo. It
needs Karan's yes because it changes what a safety check does, and it wants a
wiring chain pinning the narrow condition so a later edit cannot widen it.

**Frequency note:** naming a callback time is a normal thing for a good lead
to do, so this is not an edge case — it is the middle of A25's happy path.
