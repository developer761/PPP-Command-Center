# Hatch's live agent, read from the product — 2026-09-26

Captured read-only from Hatch with Karan's login. Nothing was sent, saved,
published or changed.

**Workspace:** CA LA Leads · **Agent:** "Emily"
(`assistant_69122c73114918000189840a`)
**Last updated** Sep 2nd 9:00am · **last published** Aug 17th 7:52am — so the
live bot is running the *August* version and there are unpublished edits
sitting in the editor.

This is the prompt Kate's Class A rules were written **against**. Where her
rule and this text disagree, her rule is the correction — several of her rule
cards say so explicitly. Keeping the original matters because it tells us
which of her rules are *new behaviour* and which are *fixes to this*.

---

## Behaviour settings (Persona tab)

| Setting | Hatch | Connect Hub |
|---|---|---|
| Response time | **23 seconds** | 30–90s (`DEFAULT_DELAY`) |
| Conversation rule | **Wait 5 hours / 1 attempt / Stalled / Only in business hours** | not built (A44) |
| Opening message | see below | campaign opener |

Opening message, verbatim:

> "Hello, this is Precision Painting Plus. Thanks for requesting a free
> estimate! Could you share details about your project and your availability
> for an appointment? Feel free to call us at (323) 529-0930 for any
> inquiries. Reply END to stop texts."

**No AI disclosure anywhere in it.** A46 is genuinely new, not a port.

## Trigger (Decision Tree)

Campaign → SF Leads Campaign - CA LA · Angi Leads Campaign - CA LA ·
Thumbtack Campaign - CA LA

Tagged **"Unmask Masked Leads"**.

---

## THE FINDINGS THAT CHANGE WHAT WE BUILD

### 1. A25 — Hatch ENDS both branches. Kate's rule is a deliberate reversal.

Hatch, verbatim:

> **Communication Preferences**
> They insist on email-only → End: Schedule Follow Up
> They insist on text-only → **End: Transferred**

Kate's A25 rule card calls this out by name: *"The durable rule hiding under
guard B8. The instruction only said END the conversation, because ending was
the only lever that stopped the texting… EVERYWHERE ELSE IN THIS RULE, ENDING
IS THE DEFECT."*

**This confirms the A25 build shipped in `838ee593` is right.** Text-only
keeps texting; the old `transferred` guidance was a port of this line, and
removing it was correct.

### 2. A36 — Hatch's own prompt carries THREE different sets of hours

All three appear in the same document:

| Where | Hours |
|---|---|
| "Call back availability to set an appointment" (stated twice) | **8 AM – 6 PM** |
| Appointment slots offered | **earliest 10 AM, latest 5 PM** |
| "business hours" for the bot-question branch | **9–5 M–F, 9–3 Saturday** |

And Kate's A36 gives a **fourth**: 9 AM–8 PM ET weekdays, 9 AM–5:30 PM
weekends, with a 7 PM customer-local cut-off.

None of these agree. Connect Hub currently implements **Kate's A36**, which is
the only one that is dated, owned and rated against. Worth her confirming
which is canonical — see `QUESTIONS_FOR_KATE.md` item 3.

Note also: appointment-slot hours (when an estimator can visit) and
callback/texting hours (when we may contact somebody) are **different things**
and Hatch's prompt runs them together. Our gate only governs the second.

### 3. A40 — Hatch already has the parking branch, and it matches Kate's (1)

> "If the customer explicitly says they do not know their availability or are
> waiting on someone else (e.g. 'not sure,' 'I need to check,' 'waiting on my
> spouse/tenant'): Confirm their project details, full address, and contact
> info as usual. **Skip asking availability.** After confirming their project
> details, full address, and contact info → End: Schedule Follow Up"

That is exactly Kate's A40 situation (1) — collect everything else, park the
one open item, do not stop early. Good news: the behaviour is specified, and
our A40 build can follow it.

It does **not** answer the no-time-park question (item 5): Hatch just ends
with Schedule Follow Up and leaves the cadence to the Conversation Rule.

### 4. A44 — Hatch does ONE follow-up, not three

The Conversation Rule is **"Wait 5 hours / 1 attempt / Stalled / Only in
business hours"**.

The Iteration 1 spec asks for **three** follow-ups at 10 AM / 3 PM / 6 PM
customer-local. That is a change in behaviour, not a port — worth being
explicit about, because "match Hatch" and "match the spec" give different
systems here.

### 5. "tenant" is used residentially in Hatch's own prompt

> "waiting on my **spouse/tenant**"

Supports A6's reading ("tenant" describes where someone lives, never a
commercial signal) over A3's list. Evidence for `QUESTIONS_FOR_KATE.md` item 2.

### 6. The bot-question branch has a distinction that does nothing

> If asked whether you are a bot **during** business hours (9-5 M-F, 9-3
> Saturday) → End: Bot Suspected
> If asked whether you're a bot **outside** of business hours → End: Bot
> Suspected

Both arms are identical. Either a behaviour was lost, or the split is
vestigial. Relevant to A46, since the disclosure will likely replace this.

### 7. Service area is EIGHT states here, eleven in our zip table

Hatch: `NJ, CA, TX, CT, FL, NY, LA, CO`.
`sms_service_zips` also carries **MD, NC, VA**. NC Leads is marked *Inactive*
in Hatch. Worth confirming whether MD and VA are live territory.

---

## A7 — the off-site quote, with Hatch's exact phrasing

**Suggest** (offer as an option) if any apply:
- customer asks for a quote today or tomorrow
- customer cannot meet within 2 weeks
- customer availability is outside business hours

> "We can text or email you a quote for faster turnaround if that's preferred
> over scheduling an in-person appointment. Which would you prefer?"

**Require** (do not offer in-person) if any apply:
- no access to the property
- project is small (1–2 rooms, one wall, a minor repair) — *and do not ask to
  clarify in order to find out*
- customer only wants a price or rough estimate
- customer prefers a quote from photos or measurements
- customer explicitly wants a quote via text

> "We can provide a quick quote for this project. Do you prefer text or email?"

**Guardrail:** even then, still collect project details, full address and
contact information, in order.

---

## The required flow

`Project Details → Full Address → Contact Information → Appointment Availability`

Endings used: Discarded · Schedule Follow Up · Area Not Serviced · Phone
Pricing · Success · Bailout · Transferred · Bot Suspected · Msg Liked Loved ·
Lost.

Notable details worth holding against our implementation:

- **Availability phrasing is day-dependent.** Sun–Wed: *"We have a few
  openings this week…"* Thu–Sat: *"…next week…"*
- **Never offer, confirm, or suggest appointment times yourself.**
- "Assume times between 8 and 11 are AM and 12 to 7 are PM."
- Flexible availability ("anytime works", "I'm flexible") is **availability
  received**, NOT "does not know availability".
- If they insist on knowing our availability first → End: Schedule Follow Up
- Photos: *"they may send them and you will forward them to the estimator once
  the appointment is booked"* — acknowledge only, matching A26's ceiling.
- Returning customer who won't re-confirm details: ask once, then move on.
- "Don't suggest that customers reach out to other companies for work we don't
  provide." — our A18.

## Tone rules (these match ours, and confirm A23)

- Friendly, casual, short; one question at a time
- Do not repeat or restate the customer's words
- Use contractions; **avoid "Yep"**
- **Avoid parenthesis, em dashes and ellipsis**
- Do not say **"Thanks for letting me know"**
- Keep structure light; sound like normal texting

Approved connectors: *"I just need to…"*, *"I need to double-check…"*,
*"Thank you! Is…"*, *"Okay! Is…"*, *"Got it! Is…"*, *"Before we…"*

---

# Part 2 — the rest of the product, and what it means for replacing it

## The shape of Hatch

32 workspaces (several marked *Inactive*), each with the same seven sections:

`Audiences · AI Agents · Campaigns · Contacts · Integrations · Workflows ·
Workspace Configs`

A **Workflow** is the wiring: *Audience → Campaign*, fired **Immediately**,
with "Audience Builder Rules applied". The **Campaign** holds the message
sequence. The **AI Agent** attaches to the campaign and takes over the
conversation. All the CA LA workflows were last edited by **Kate Sutton**.

## THE HOURS QUESTION IS ANSWERED — and A36 needs rereading

Business hours are configured **per workspace**, under Workspace Configs →
General. CA LA Leads:

| Day | Open |
|---|---|
| Sun | 9:30 AM – 4:30 PM |
| Mon–Fri | 9:00 AM – 7:00 PM |
| Sat | 9:30 AM – 4:30 PM |

**Hatch's workspaces are geographic** (CA LA, NY Nassau, CO Denver…), so
per-workspace hours are per-*region* hours. That is how Hatch gets away with
resolving against a workspace clock: the workspace IS the customer's region.

This does **not** make our customer-clock fix wrong — a lead can sit in the
wrong workspace, which is exactly the case the old `gate.test.ts` encoded
(a 516 number in a San Diego workspace) — but it reframes A36: it is not one
global window, it is **per-workspace hours plus a customer-local floor**.
Connect Hub already stores `quiet_hours_start/end` per workspace, so the shape
matches; the values need to come across.

Counting the sets of hours now found in one system: **six**. Callback 8–6,
slots 10–5, bot-question 9–5/9–3, FAQ 10 AM–6 PM, Kate's A36 9–8/9–5:30, and
these per-workspace settings. Only the last is actually enforced.

Also here: **"Inherit From: Precision Painting Plus"** — an account-level
default that workspaces inherit. We have no such concept; every workspace
carries its own copy.

## After-hours: they compute the next open time, we don't

> "Thanks for reaching out! We are currently closed, but we wanted to confirm
> we received your message. We'll get back to you as soon as possible after we
> open at **[[[[Next Open Time]]]]**."

A merge field resolved against the workspace's hours. Our
`after_hours_message` is static text, so we cannot say when we open without
somebody hand-editing it per workspace. **Genuine gap, small to close.**

## The campaign cadence — where the spec's 10 AM / 3 PM / 6 PM comes from

SF Leads Campaign - CA LA, sequence by day (30 days available, "Add 30 more"):

| Day | Steps |
|---|---|
| Launch | SMS at launch (**Delay 1 min**), then **email 15 mins** after |
| Day 2 | SMS **10:00 am**, SMS **6:30 pm** |
| Day 3 | email **9:00 am**, SMS **11:15 am** |
| Day 4 | SMS |
| Day 5 | SMS |
| Day 6–30 | empty |

So the times are **hand-tuned per day**, not a fixed three-a-day rhythm. The
spec's "10 AM / 3 PM / 6 PM" is a tidied-up version of this. Worth deciding
whether we implement the spec's regular rhythm or Hatch's bespoke schedule —
they are not the same product behaviour.

Campaigns also have a **"During business hours" / "After business hours"**
split, so a step can carry different copy depending on when it fires. We have
no equivalent.

**TWO SEPARATE CADENCES, and they must not be merged** (this confirms the
existing note in memory):

1. **Campaign sequence** — outbound nurture for a new lead (above)
2. **Conversation Rule** — the bot's stall follow-up: *Wait 5 hours / 1
   attempt / Stalled / Only in business hours*

A44 is the second. The first is the campaign.

## Hatch does VOICE. We do not.

Workspace Configs → Features:

- **Call Forwarding: ON** → (877) 645-3563
- **Voicemail Greeting**: off, but recordable/uploadable
- AI agent types offered: **Inbound Calls**, Outbound (campaigns), From Scratch
- Reporting has a **Voice** tab alongside Text, and the human-agent table has
  Calls and voice Avg. Duration columns (Matt took 29 calls at 54s average)

**This is the largest single gap.** Connect Hub is SMS + email. If Hatch goes
away, call forwarding and voicemail have to live somewhere, and that is a
decision for Karan and PPP, not a build task we can absorb quietly.

## Suggested Responses (snippets) — a feature we lack

Reusable named snippets a rep can drop into a reply, and campaign steps can
reference:

`Generic Post Contact Followup · Availability · Estimate Confirmation - In
Person · Project Details · Follow-up Text #1–#3 (Day 1–3) · Circling Back
#1–#2 (Day 1–2) · Initial SMS`

Our office UI has no snippet library.

## The real operating baseline (Sep 20–26, 2026)

**342 text conversations in one week.**

AI agents (15 rows, top 5):

| Agent | Workspace | Conversations | Success | Avg duration |
|---|---|---|---|---|
| Emily | NJ Leads | 22 ↗ | 40.9% ↗ | 8 min |
| Emily | NY LI Meta | 13 ↘ | 30.8% ↗ | 2 min |
| Emily | NJ Meta | 14 ↗ | 7.1% ↗ | 13 min |
| Emily | NY NYC Leads | 12 ↗ | 16.7% ↗ | 5 min |
| Emily | NY LI Suffolk | 6 ↗ | 16.7% ↗ | 5 min |

Humans (7 rows, top 5):

| Agent | Conv. | Calls | Text avg duration | Response time |
|---|---|---|---|---|
| Rodolfo Hermosura Jr. | 177 ↘ | 0 | 3d 9h | 7 min |
| Matt . | 63 ↗ | 29 (54s avg) | 3d 16h | 2 min |
| Jasmine Guidry | 14 ↘ | 0 | 2d 15h | 2h 28m |
| Rachel Pope | 14 ↘ | 0 | 2d 3h | 4 min |
| Niro Roca | 4 ↘ | 0 | 2d 10h | 2h 27m |

Two things to take from this:

- **Bot success ranges 7%–41% by workspace.** That is the bar to beat, and it
  is measured per workspace, which is how we should measure ours.
- **Connect Hub has ten seed conversations and no real traffic.** Any claim
  that we are "better" is currently a claim about code, not about outcomes.

## Metrics Hatch reports that we do not

- **Containment** — share handled without a human. The single most important
  bot metric, and we have nothing equivalent.
- **Bookable to Booked** — conversion of qualified leads into appointments.
- **Avg. Duration** and **Response Time** per agent, bot and human.
- Trend arrows against the previous period on every figure.
- Organization / Workspace / date-range filters on everything.

(Both Containment and Bookable-to-Booked showed "–" for every row, so Hatch
is not populating them either — but the columns exist and ours do not.)

---

# Honest read: are we ready to replace it?

**Where Connect Hub is genuinely ahead**

- **The rules are enforced in code, not asked for in a prompt.** Hatch's whole
  rulebook is one long instruction block; every guarantee depends on the model
  choosing to comply. Ours has a gate no caller can configure past, a
  validator, and 5,289 tests.
- **Compliance.** Hatch resolves hours per workspace and has no customer-clock
  floor at all. We refuse sends outside the recipient's own federal window and
  prove it across 1,210 permitted instants.
- **Suppression.** 31,601 imported suppressions, a port rail that refuses to
  send while the list is empty, and two surfaces reconciled against the table.
  Nothing equivalent was visible in Hatch.
- **Internal consistency.** Hatch carries six different sets of business hours
  and a bot-question branch whose two arms do the same thing. Ours has one
  window rule with one implementation.
- **The work is verifiable.** 11 verify steps, sabotage-tested.

**Where Hatch is still ahead, and these are real**

1. **Voice.** Call forwarding, voicemail, inbound-call agents, voice
   reporting. We have none of it.
2. **Containment and Bookable-to-Booked** as first-class metrics.
3. **Snippets** — a reusable response library for reps.
4. **Next-open-time merge field** in the after-hours reply.
5. **Business-hours-aware campaign copy** (during/after variants per step).
6. **Account-level inheritance** of settings, so 32 workspaces don't each need
   editing.
7. **A 30-day campaign designer** with a day rail showing at a glance which
   days carry SMS and which carry email. Genuinely good UI; ours is a list.
8. **Proven traffic.** 342 conversations a week through a system people
   already know how to use.

**The honest summary:** on correctness, compliance and verifiability we are
ahead, and those are the things that were actually going wrong. On breadth of
product — voice, snippets, inheritance, campaign tooling — Hatch still does
more. Replacing it is a decision about scope, not about quality.
