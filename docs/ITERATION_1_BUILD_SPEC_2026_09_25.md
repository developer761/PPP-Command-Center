# Hatch replacement — Iteration 1 build spec (25 September 2026)

Supplied by Kate, 2026-09-29. **This is the authoritative statement of what
Iteration 1 must do.** It arrived after most of the build, which is why it is
saved here rather than paraphrased: a spec we argue with later has to be the
spec as written, not as remembered.

11 capabilities · 37 live rules · 2 internal builds · 6 open items, none blocking.
Booking and the calendar-dependent rules are Iteration 2 and are out of scope.

---

## The case

Hatch turns work away for three structural reasons: it cannot hold state
between messages, it cannot tell what time it is, and it cannot see a photo.
Stalls and parks together account for roughly **44%** of conversations handed
to a human because of what Hatch cannot do rather than because a person was
needed.

| Failure | Baseline to beat |
|---|---|
| Cannot hold state | **192** defects for asking a customer to retype data already held |
| Cannot tell the time | **237** stalled conversations; none got three follow-ups, **208** got none at all |
| Cannot see a photo | **42 of 45** replies after a customer photo never mentioned it |

## How one conversation runs

Lead arrives → opener (in hours / out of hours) → the required flow
(project details → full address → contact info → availability) with
conversation memory underneath → one of four endings: a person takes over,
it parks, it stalls, or it books (Iteration 2).

The call centre runs its own phone cadence alongside. **Exactly two signals
cross, in one direction:** the customer's reply pauses calling, and follow-ups
spent without a reply resumes it. Neither writes to Salesforce.

The three stall follow-ups go out at **10 AM, 3 PM and 6 PM the customer's
local time**.

## Build order

1. **Conversation memory** — first; nothing that returns to a conversation works without it.
2. **Business hours** — second; a gate two other behaviours read. Reuses A36's callback window. No new clock.
3. **Parking · Stalled conversations · Pause and resume calling** — build together; the resume signal fires off the end of the stalled cadence.
4. **AI disclosure** — wording driven by the hours gate.
5. **Human takeover · Communication preference · Photos · Message reactions · Language** — independent, any order.
6. **Rule Hub, then the auto-rater** — the rater scores against the rules the Hub displays.

---

## The eleven capabilities

| Capability | Needs | How we will know it works | Rules |
|---|---|---|---|
| Conversation memory | nothing | No held field asked for twice. Baseline 192 A13 defects | A3 · A9 · A13 |
| Business hours | nothing | 7:30 PM ET: a CA lead gets in-hours behaviour, an ET lead gets the prefix | A36 |
| AI disclosure | business hours | Both strings byte-for-byte; the bot never denies being a bot | A46 |
| Human takeover | nothing | Thread stays open, bot sends nothing on the way out | A7 · A15 · A35 · A36 |
| Parking | memory | Bot re-opens the thread itself, with full context | A40 |
| Stalled conversations | memory + hours | Three follow-ups, no closing line. Baseline 208 of 237 got none | A44 · A36 |
| Pause and resume calling | stalled | One pause per conversation, not per reply; resume only where never reached | A45 · A44 |
| Communication preference | nothing | Never edits the cadence; captures a callback time before any phone hand-off | A25 · A7 |
| Photos | nothing | Photo named in one line, never priced. Baseline 42 of 45 ignored | A26 |
| Message reactions | nothing | Never arrives as text; yes/no advances, open question is rephrased | — |
| Language | nothing | A two-word signal switches it, every later turn stays switched | A30 |

### Conversation memory — build first
State that survives multi-day gaps. A customer replying three days later is
answered at the next outstanding thing, with no re-introduction, and no held
field is asked for twice.

### Business hours — build second
Use A36's callback window. **No new clock.**

> CALLBACK WINDOW to SET an appointment (Eastern): Mon-Fri 9 AM - 8 PM · Sat
> and Sun 9 AM - 5:30 PM. Within it: 9 AM-7 PM ET for clients in Eastern;
> after 7 PM ET no outbound to Eastern clients until the next day; 7-8 PM ET
> is the hour for CA/CO (Pacific/Mountain). Never call a Pacific or Mountain
> customer before 9 AM THEIR local time.

**Done when:** never offers a person outside that customer's own callable
window; the out-of-hours prefix appears unprompted on the **first reply only**;
7:30 PM ET gives a CA lead in-hours behaviour and an ET lead the prefix.

**Watch for:** in hours is **per customer, not per clock**. A single global
"are we open" flag gets two of the six states wrong every evening. The
callback window is open Sunday 9 AM–5:30 PM even though the appointment
calendar is not.

**Decided 25 Sep:** the bot is not held back out of hours. It answers in a
different voice — disclosure up front, no offer of a person, and a commitment
only to pass details on once we open.

### AI disclosure — A46, needs business hours
In hours, **only when asked**, verbatim:

> I'm an AI assistant, but I can take your project details and get you set up with an estimator. Would you prefer to speak with a member of our team?

Out of hours, prefixed to the reply already being sent, verbatim:

> I'm an AI assistant, but I can take your project details and pass them along once we open.

Straight apostrophes. English only — A30 picks the language and where it is
not English, say the same thing in it. **The disclosure is what must not vary,
not the wording.**

**Watch for:** the out-of-hours line adds **no ask**. No callback offer, no
question — out of hours there is nobody to connect them to, and a promise with
no owner is worse than none. The old "I'm a real person!" instruction is
retired; the bot never denies being a bot, in any state.

**Decided 25 Sep:** applies in every state, not only CA and NJ. Not a
compliance requirement — a decision about how we come across.

### Human takeover — A7 · A15 · A35 · A36
The bot pings an agent, who answers in the same thread. **The bot sends
nothing on the way out** — no sign-off, no handover line. No visible seam.
This is the hand-off in a live conversation, not the end of a stalled one;
the two were read as one feature once already.

### Parking — A40, needs memory
The bot sets its own reminder and re-opens the conversation at the time the
customer named. **A park is a reminder, not an appointment** — nothing is
reserved and no message may imply otherwise.

Where no time is named, the wait depends on why:

- **Bare deferral** ("I'll get back to you", "once I've spoken to my wife") —
  follow up after **2–3 days, three times**, then notify the call centre to
  resume. The common case by a wide margin: of 163 no-date parks, **136 give
  no reason at all**.
- **Blocked on a named event** (moving, a closing, an insurance payout, no
  power, travelling) — **two weeks**.
- **Asks not to be chased** — no cadence at all; hand to the call centre.

Run **A7 first** before accepting a blocked park: offer the visit for when
they will have access, then the off-site quote, and park only if they decline
both.

**The park cadence REPLACES the stalled cadence, it does not precede it.**
When the third park follow-up goes unanswered the conversation is silent,
which would otherwise trigger A44 and send three more messages. It does not —
the park cadence ends in the resume-calling notification directly.

**Watch for:** the bot coming back has **never once happened** in the corpus.
That half is untested; expect to adjudicate the first few.

### Stalled conversations — A44 · A36, needs memory + hours
Three follow-ups, one per day, at **10 AM / 3 PM / 6 PM the customer's local
time**, shifted around A36's outbound hours and any window they said they were
unreachable in. Runs as a campaign of its own.

Fires on a **mechanical test**: the last turn is a bot turn and no human ever
picked it up. 237 of 1,279 conversations. Nothing about the lead's status
enters into it.

**Not the campaign that already exists** — the day 1 / day 3 follow-ups at
10 AM are steps 3 and 4 of the Leads Master Campaign, which chases someone who
never replied at all. Different population. Leave them.

**Done when:** three follow-ups at those local times; **nothing sent at the
end** — no sign-off and no softer sign-off in its place; each follow-up names
the scope where we hold it; the call centre gets a resume-calling notification;
the Hub records the ending as *Stalled conversation*; **Salesforce untouched**.

**Watch for:** A36's outbound hours beat the 10/3/6 pattern — 6 PM Pacific is
9 PM Eastern. The third follow-up landing earlier for Pacific and Mountain is
**correct, not a gap**. Reaching the end of the cadence is a resume signal, not
a disposition — a notification reading "this lead is done" is the failure.

The no-sign-off ending applies **at the end of A44's cadence and nowhere
else**. A40's park ending and A25's phone branch keep their closing line.

### Pause and resume calling — A45, needs stalled
Two notifications. **Pause** when the customer replies on text or email.
**Resume** if the conversation is still stale at the end of A44's cadence.

**Done when:** one pause per conversation, not one per reply; resume only at
the end of A44's cadence and only where never reached; neither signal edits
the cadence or writes to Salesforce.

Delivery is **deliberately unspecified** and not a blocker — build the signals
with the destination as a seam. Each carries the lead, the conversation, and
which signal it is.

**Watch for:** a pause is temporary; A25 is permanent. A45 carries zero
defects and zero good turns in the corpus **correctly** — Hatch had no such
capability, so a rater producing A45 findings on that corpus is miscalibrated.
The hand-back is **A44's**, not A45's.

### Communication preference — A25 · A7
Continue in the channel the customer named; **notify a human** to remove them
from the Salesforce call cadence. The bot never edits the cadence itself.

On text or email, ending the thread is a defect. **A phone request is the
exception** — the bot cannot call, so it hands off, but it must settle a
callback time first: capture the time, test it against A36's window, confirm
("we will reach out then") if inside or state the hours and ask for a time
within them if outside, then hand off. **The handoff is not announced** — the
customer is told when we will call, not who is typing. Ending without settling
when to call is the defect.

**Decided 24 Sep:** Iteration 1 is a notification; an agent removes them in
Salesforce. Build the signal, not the cadence edit.

### Photos — A26
Two levels: read the image if reachable, otherwise detection only. Either way
the bot knows an image arrived and how many, **names it in one short line**
("thanks, got the photos"), and carries on. Photos forwarded to the estimator
once booked. **No reply ever prices from an image, at either level.**

**Watch for:** interpretation is not quoting. Reading images is **metered
spend** — about 125 images a month (108/157/103 June–August), and that is a
floor: it counts only images sent with no accompanying text.

### Message reactions — no rule of its own
A reaction must arrive as a **structured signal naming the message it points
at**, never as text. On a yes/no question it is the answer (like/heart = yes,
thumbs-down = no) — acknowledge and advance. On an open question it is not an
answer — rephrase. **No conversation ends on a reaction while the required
flow is incomplete.**

**Watch for:** Hatch delivered a reaction as a message quoting our own text
back, so the bot read its own question as something the customer had said and
answered it. One conversation ended that way and **lost a full exterior
repaint**.

### Language — A30
Reply in the customer's language and keep replying in it. **A two-word signal
is enough** — the corpus trigger is "Sábado 9:30 am", a day and a time. No
hand-off to a person for language alone; Hatch's fallback of handing any other
language to a person is **retired**.

**Watch for:** switching back to English on the next turn.

---

## Two internal builds

### Rule Hub
One row per live rule (id, statement, severity, status, last modified) and a
detail view: the rule as the bot receives it, the record of change, and the
tagged conversations.

**Done when:** all **37 live rules** listed and the **9 retired** ones are
not; the five prompt fields render **byte-identical** to the cell, casing
included; A13 opens to **192 defects and 77 good turns**; A35 opens to **zero
of both** and renders as a rule nothing has exercised, not as an error; every
rule shows **exactly one date**, the stamped one.

**Watch for:** render both the date and the change type, or neither. `History`
stays in Kate's record and is **not** rendered on this screen.

### Auto-rater
Rates every Hub conversation as it finishes, turn by turn, against the live
rules. Output in the shape of `hatch DEFECT NOTES.csv` / `hatch GOOD TURNS.csv`
— one row per finding with rule id, turn and reason, keyed to the conversation.

Reads `Rating guidance`, **which the bot never sees**. That split by
destination is the whole reason those columns are separate, and it must be
**provable** that rating guidance reaches no bot prompt.

**Watch for:** a rule with no findings is not a broken rater. A45 and A35
carry zero of both in the handover corpus because Hatch had no such
capability.

---

## What is still open — none of it blocks

| Owner | Item |
|---|---|
| Kate, partly decided | **Voice.** Call forwarding is Iteration 1 — 244 inbound calls a month, median 2m40, 70% over a minute. **Voicemail is TBD** (~11 calls a month unanswered, no mailbox). An inbound-call agent is not Iteration 1 and would change A25's premise if it ever were. |
| Kate | Which already-unqualified leads may still be texted — decided when cadence settings are configured. **No field gate to be built against it yet.** |
| Ours | How the two call-centre notifications are delivered. A seam on purpose. |
| Ours | How the park reminder actually fires. |
| Kate, not a blocker | Some handed-over conversations may need re-rating — phone-pricing detection changed after parts of the corpus were rated. |
