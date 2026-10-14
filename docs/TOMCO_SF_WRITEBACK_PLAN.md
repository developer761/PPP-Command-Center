# Tomco → Salesforce write-back (SOLD only)

Katie, 2026-10-13: *"we need to write back to salesforce for tomco only dont mix it
with PPP … whenever we write in the commercial platform it should immediately write
back into their salesforce."* Narrowed the same day: **"this can be for sold only."**

And the WHY, which turns out to decide the whole design:

> **Karan:** They're going to start using the commercial platform moving forward but
> we still want to keep Salesforce for a little bit, correct?
>
> **Katie:** *"Yes, so we can see their sales in SF alongside all of the other sales
> from PPP. To get a total sales picture. Eventually when we move PPP over, we will
> do the full company reporting in the command center."*

Status: **PLAN — nothing built, nothing written to Salesforce.**

Companion document: `docs/SALESFORCE_WRITEBACK_QUESTIONS_FOR_KATIE.md` (2026-09-22)
carries **Katie's answers** — record types, ownership, close-date policy. Read it
first; do not re-ask what she has already settled. Its **Q2** asked for an
external id called `CCC_Id__c`; Katie answered it on 2026-10-13 by creating
`UniqueExternalId__c` instead. **`CCC_Id__c` does not exist in either org** — any
remaining mention of that name anywhere is stale.

---

## 0⁻. THE SHAPE, as Karan described it 2026-10-13

> *"Once sales are closed, that's what goes into Salesforce. If it's a new
> account it's gonna write in the Account, the Opp; if it's an old account it
> just writes back. And the proposal has to become a Quote in Salesforce and
> accepted. Change orders after it's sold."*

That is five objects in a fixed order, and the order matters because each one is
the parent of the next:

```
1. Account        only when the GC is new to Salesforce
2. Opportunity    the sale
3. Quote          the accepted proposal
4. QuoteLineItem  one line — see §2c, this is a placeholder in Tomco's data
5. ChangeOrder__c each CO approved here, after the sale
```

**And the Quote changes a conclusion in this document.** §5 retracted the claim
that marking a deal won emails the GC, on the grounds that
`Opportunity_WorkOrderWhenClosedWon` is update-only **and requires
`SyncedQuoteId != null`**. Step 3 supplies exactly that. **With a synced Quote,
the flow fires: Salesforce creates the WorkOrder, the WorkOrderLineItems and the
`Payment_Term__c` rows — and `WorkOrder_SendLetsGetStartedEmail` sends the GC a
"Let's Get Started" email.**

### ✅ ALL THREE BLOCKERS CLEARED — Katie, 2026-10-13 22:52

> *"UniqueExternalId__c has been created in Sandbox and Production."*
> *"Quota points flow is now excluding Tomco."*
> *"When the Quote is created in SF and marked as Approved, it can be Synced as
> well — the Let's Get Started email is excluding Tomco opportunities as well."*

Verified against the org:

```
Opportunity.UniqueExternalId__c   string(255)  externalId=true  unique=true
                                  createable=true  updateable=true  populated on 0 records
```

**The sale keys on `UniqueExternalId__c`** carrying the Command Center
opportunity id.

🔴 **But read §4 before believing this closes the duplicate problem — it does
not.** The field is populated on **0 of 198** Tomco opportunities, and Mary is
still creating Tomco opportunities directly in Salesforce (14 since 2026-09-01,
including today). An unpaired key is not a guard: the first write-back would
insert twins for 2 of its 4 deals. The field makes pairing *durable*; a human
still has to do the pairing once.

🔴 **And it cannot be `upsert()` anyway** — see §2a¹. `CloseDate` is
`nillable=0, defaultedOnCreate=0`, so the insert path requires it and the
update path forbids it. Query-then-branch, not upsert.

**And the Quote can be synced**, which restores Tomco's own convention: all 10
approved Tomco quotes sampled carry `SyncedQuoteId`. With the email excluded,
syncing costs nothing and keeps our records shaped like theirs.

⚠️ **The field is on Opportunity ONLY** — confirmed absent on Account, Quote,
WorkOrder and `ChangeOrder__c` (`describe`, 2026-10-14). That is workable for
v1, but the reasons differ per object and one of them is a genuine gap:

| Object | Guard instead of an external id | Good enough? |
|---|---|---|
| Quote | query by `OpportunityId` — one quote per opportunity (§2b) | ✅ cheap and exact |
| `ChangeOrder__c` | query by `WorkOrder__c` + match on amount (§2d) | ✅ for 43 Tomco COs; revisit if volume grows |
| **Account** | **exact-name lookup immediately before the insert** (§2a²) | ⚠️ **the one create with no external key.** Low volume (~2 new GCs/month) but it is a real race, and `Account.UniqueExternalId__c` is the fix. Ask Katie |

> ⚠️ **Verify the two exclusions on the first write, do not assume them.** Flow
> bodies return `INSUFFICIENT_ACCESS` to this connection, so nobody here can
> read the quota-points or email filters. The first write should be ONE deal, in
> the sandbox, with `QuotaPoints__c` rows and the GC's email activity checked
> afterwards — then one in production, same check, before any batch.

### 🟢 …and we did not have to send it — SUPERSEDED, kept for the reasoning

**Katie excluded Tomco from the email automation on 2026-10-13, so the Quote is
now synced normally and this workaround is not used.** The analysis is kept
because it is the fallback if that exclusion is ever found not to cover a case,
and because it documents what `SyncedQuoteId` actually controls.

Karan, 2026-10-13: *"do we have to send an automated email out?"* No.

**`Opportunity.SyncedQuoteId` is `updateable: true, nillable: true`** — whether a
quote is SYNCED is a separate act from whether it is APPROVED, and we control it.
The work-order flow requires `SyncedQuoteId != null`, so leaving it null means
the flow never enters and no email is sent.

That is not an invalid record, either: **9 Tomco opportunities are already Closed
Won with no synced quote**, and 5 of them carry work orders created another way.
It *is* a departure from their habit — all 10 approved Tomco quotes sampled are
synced — which is why Katie should be told rather than left to notice.

**So: create the Quote, set `Status = 'Approved'`, leave `SyncedQuoteId` null.**
Katie gets the sale, the Opportunity, the accepted Quote, the contract value and
the change orders. The GC gets nothing. No change to PPP's org, no admin
permission, nobody to wait for.

The honest trade-off: a Tomco sale will sit in Salesforce with no work order
attached. If Mary later adds one by hand the email fires then — on her
deliberate action, for a job she is already working, which is a far better place
for it than a bulk sync.

**Set `StageName = 'Closed Won'` explicitly as well.**
`Quote_SetOpportunityStageClosedWonOnApproved` is active, but its body returns
`INSUFFICIENT_ACCESS` so nobody here can read whether it keys on approval alone
or on the sync. Writing the stage ourselves costs nothing — if the flow also
sets it, both are writing the same value.

## 0. The whole feature, in one paragraph

The purpose is **reporting, and it is temporary**: Katie wants Tomco's sales visible
in Salesforce next to PPP's until PPP moves onto Command Center too. So we write
**the sale and its value — not the state**. No work-order status, no progress, no
delivery stage. Every ambiguity that makes a general sync dangerous lives on
`WorkOrder.Status`, which a sales report never reads, so it is designed out rather
than guarded against.

**And the backfill is unnecessary** — see §1, which is the single biggest correction
to the earlier draft of this plan.

---

## 1. 🔴 THE 94 EXISTING DEALS NEED (ALMOST) NOTHING. Writing to them does damage.

The earlier draft proposed writing four fields across all 98 sold deals. Measured
against production, that would have been actively harmful.

**The arithmetic, measured 2026-10-14.** 98 Command Center deals are sold
(`pre_sale_closed`+won / `pre_construction` / `in_progress` / `billing` /
`post_sale_closed` — the `WON_OR_DELIVERING` set at
`lib/commercial/opportunities/status.ts:798`). **94** carry an import-map row,
leaving the **4** of §4. An earlier draft said 93; the 94th is the exception
below.

**`StageName` is already `Closed Won` on 93 of those 94.** Writing the value a
record already holds is not a change — so `ISCHANGED(StageName)` is false, which
means `Close_Date_Uneditable_after_Closed_Won_L` fires and **rejects the entire
update**. Fields 1 and 3 of the old four-field plan are inert here.

#### ❗ The one exception, and it is a real missing sale

```
006Wj00000hDlTNIA0  "MotorMindz- TLA"  →  StageName = Estimate Sent
```

Sold in the Command Center, still an open estimate in Salesforce at **$30,000**.
It is sitting on the open-opportunity list in §4 right now. So the honest version
of this section is **93 of 94 need nothing, and 1 needs exactly what the
write-back does** — which makes it the single best first test case in
production: it is already paired (the map has it), so it exercises the UPDATE
path with no create, no account match and no new quote.

Worth telling Katie separately: her Tomco sales total is short by this $30,000
today.

**`OwnerId` is already Brendan** on 181 of 188 Tomco opportunities.

**And the money field would DELETE $192,594.77 of real sales.** This is the one that
matters. `commercial_projects.contract_base_cents` is deliberately the contract
**EXCLUDING** change orders — `originalContractCents` subtracts `TotalChangeOrder__c`,
and its docblock records why (Stephanie, 2026-09-22: *"CCC is totaling the CO's and
original contract amount … kind of double dipping"*). The Salesforce target
`Quoted_Subtotal_with_Change_Order__c` is the opposite concept: `QuotedSubtotal__c +
TotalChangeOrder__c`. Writing one into the other overwrites a correct value with a
low one on 19 deals:

| Salesforce today | the old plan would write | loss |
|---|---|---|
| $100,127.09 | $69,000 | −$31,127.09 |
| $76,125 | $45,750 | −$30,375 |
| $121,575 | $99,800 | −$21,775 |
| $2,800 | $535 | −$2,265 |
| … 19 deals | | **−$192,594.77** |

**Conclusion: there is no backfill.** The 94 deals came *out* of Salesforce and
Salesforce still holds 93 of them correctly. The write-back exists for what
happens next — plus the one MotorMindz stage flip above.

---

## 2. What actually needs to go to Salesforce

### 2⁰. 🔴 THE CONTRACT IS WRITTEN ON THE QUOTE LINE, AND ROLLS UP FROM THERE

**This section has now been wrong twice.** Both earlier versions would have put
$500 or $0 on every Tomco sale, and both were written from reasoning about field
names rather than from the data. What follows is read off **191 of 191** real
Tomco quote lines.

```
QuoteLineItem.PriceOverride__c       = true        ← a BOOLEAN flag
QuoteLineItem.PriceOverrideAmount__c = contract    ← THE MONEY. The only field
                                                      we write it to.
   └→ TotalPrice__c   formula: IF(PriceOverride__c, PriceOverrideAmount__c,
                                  (Quantity*UnitPrice)+DisposalCost__c)
        └→ Quote.Subtotal__c           rollup summary of the lines
             └→ Quote.QuotedSubtotal__c    formula
                  └→ Opportunity.Quote_Subtotal__c   (set by a flow)
```

Every Tomco quote shows standard `Subtotal = 500` beside `Subtotal__c =
1,850 / 25,000 / 55,145.60 / 99,800` — the override amount, never
`Quantity × UnitPrice`. The $500 unit price is a placeholder the override
bypasses, which is also why `Opportunity.Amount` reads $500 across the board.

**Four fields the earlier drafts named, and why each is wrong:**

| Field | Why not |
|---|---|
| `QuoteLineItem.TotalPrice__c` | **FORMULA, `createable=0`.** A draft wrote it — `INVALID_FIELD_FOR_INSERT_UPDATE` on the first call |
| `QuoteLineItem.PriceOverride__c` as the amount | it is a **boolean**; the amount is `PriceOverrideAmount__c` |
| `Opportunity.Quote_Subtotal__c` | a **mirror of the Quote** — populated on **0 of 15** Tomco opps with no quote, matching a quote on **182 of 183** with one. Writing it at step 2 is overwritten by step 3 |
| `WorkOrder.QuotedSubtotal__c` | **FORMULA** over `OriginalSubtotal__c`, a rollup of WorkOrderLineItem. Nothing on the Opportunity feeds it — a draft invented that link |

> **The rule: write `PriceOverride__c = true` and `PriceOverrideAmount__c =
> the contract base` ON THE QUOTE LINE. Write no other money field anywhere.
> Then read back `Opportunity.Quote_Subtotal__c` and confirm it arrived.**

#### ⚠️ The CO-inclusive total may never populate at all

`QuotedSubtotalWithChangeOrder__c` is set on **95 of 95** Tomco opportunities
that have a work order, and **2 of 103** that do not. A write-back deal has no
work order, and this user **cannot create one** — the Tomco WorkOrder record type
reads `available=false`.

So for our deals that field stays **NULL**, and any assertion on it fails by
construction. Katie's CO-inclusive figure comes out **blank rather than wrong** —
better, but not what she asked for. §2f is the question that decides it.

### 2a. The Opportunity — the sale

**Upsert on `UniqueExternalId__c`** = the Command Center opportunity id (uuid,
36 chars, field is 255). Verified `externalId=true unique=true createable=true
updateable=true`, currently null on every record in both orgs.

| Field | Value | Verified |
|---|---|---|
| `UniqueExternalId__c` | our `commercial_opportunities.id` | the upsert key |
| `Name` | deal title, **truncated to 120** | ★ required; field is 120 not 255, our titles allow 200 and `title_override` is uncapped |
| `StageName` | `'Closed Won'` | ★ required; the only `IsWon` stage in the org |
| `CloseDate` | `decided_at` | ★ required — **but see §2a¹, it must not be sent on update** |
| `AccountId` | from §2a² | not required by the API, but a sale with no account is an orphan |
| `RecordTypeId` | Tomco — **look up by name, never hardcode** | prod `012Kf000000L8Q6IAK`, sandbox `012DG000000g8mNYAQ` |
| `OwnerId` | Brendan — **look up by username** | prod `005Kf0000021SPzIAM`; that id does not exist in the sandbox |
| `Pricebook2Id` | the "Tomco" pricebook — **look up by name** | load-bearing, not optional — §2c |
| `LeadSource` | `'Tomco'` | 165 of 198 Tomco deals; empty buckets us as marketing in PPP's close-rate split |
| `LeadGroup__c` | `'Other Marketing'` | 164 of 198 |
| **never write** | `Amount` | forced to the quote total ($500) by the org |
| **never write** | `Quote_Subtotal__c` | a **flow mirrors it from the Quote** — anything we write at this step is overwritten at step 2c. §2⁰ |
| **never write** | `QuotedSubtotalWithChangeOrder__c` | §2⁰ — it is a rollup target |
| **read back and assert** | `Corporate_Name__c`, `OwnerId`, `Quote_Subtotal__c` | §2a³, and §2⁰ for the money |

**Nothing in this table carries the contract value.** The Opportunity is
identity, ownership and stage only; the money arrives from the Quote line in
§2c and is then *verified* here by read-back. An earlier draft listed
`Quote_Subtotal__c` as a field to write — that is now in the never-write rows.

#### 2a¹. `CloseDate` — why this CANNOT be an upsert

`Close_Date_Uneditable_after_Closed_Won_L` fires on
`ISCHANGED(CloseDate) && NOT(ISCHANGED(StageName))` — so sending the date on an
UPDATE of an already-won deal is rejected forever.

A previous draft said "upsert without `CloseDate`, then set it when the result
says created". **That is impossible:** `CloseDate` is `nillable=0,
defaultedOnCreate=0` — an insert without it fails `REQUIRED_FIELD_MISSING`. One
upsert call cannot send a field on insert and omit it on update.

**So the sequence is query-then-branch, not upsert:**

```
SELECT Id FROM Opportunity WHERE UniqueExternalId__c = <our deal id>
  found    → UPDATE, omitting CloseDate
  not found → INSERT, including CloseDate
```

The external id still does its job — it is what the query matches on, and it
makes the insert path unreachable once a record exists. We simply cannot use
`upsert()` to express it.

The current connection holds `Admin_Bypass` and skips this rule entirely, so a
test as Karan proves nothing. **Test as a user without it.**

#### 2a³. `Corporate_Name__c` decides whether the record exists at all

Every Tomco query in Command Center AND the importer's own scope
(`import-tomco.mjs:61`) filters `Corporate_Name__c = 'Tomco Painting'`. It is set
by `Opportunity_CorporateNameAssignmentFromOwner` v5 **from the final owner**,
after `Opportunity_SetServiceTerritoryAndOwner` v50 has had a chance to reassign
that owner.

The 2026-09-22 sandbox rehearsal came out with **`Corporate_Name__c = null` on
both the Opportunity and the WorkOrder** — a record invisible to both systems'
Tomco queries. Read it back after every write and fail loudly if it is not
`'Tomco Painting'`.

### 2a². The Account — match first, create only when there is genuinely nothing

An earlier draft said *"v1 does not create accounts"* and reported unmatched GCs
for a human instead. **Karan pushed back and the data says he was right.**

`AccountId` is not required on an Opportunity, so skipping does not fail — it
produces an ORPHAN sale: a won job in Salesforce that appears on no GC's account
page and in no customer report. Cummins already has a won deal that would have
landed exactly that way.

Measured 2026-10-14 — 7 live accounts carry no Salesforce id, 5 of them real
(the other two are test data and the "Direct / One-off" placeholder). Querying
Salesforce by **exact name**:

| Command Center | Salesforce | |
|---|---|---|
| Cummins Sales and Service | "Cummins **s**ales and Service" | ✅ link |
| Spano Industries | exact | ✅ link |
| Vision General Contractors | exact | ✅ link |
| Afton Electrical | nothing | ❗ create |
| Doherty Enterprises, Inc. | nothing | ❗ create |

**SOQL `=` on `Name` is case-insensitive**, which is why the Cummins variant
resolves without any fuzzy matching. So the rule is simple and needs no
similarity scoring:

```
exact name match, exactly one  → LINK it, record the id, never create
exact name match, more than one → ASK; two GCs cannot share a name by accident
no match at all                 → CREATE
```

**The create payload — and the field the earlier draft left out:**

| Field | Value | Note |
|---|---|---|
| `Name` | `commercial_accounts.company_name`, **truncated to 255** | `nillable=1` in `describe` but the API rejects a business Account without it — send it always |
| `RecordTypeId` | Tomco Account RT, **looked up by name** | prod `012Kf000000L8Q5IAK` — **note it is `…L8Q5IAK`, one character off the Opportunity's `…L8Q6IAK`**. Omitting it silently files the GC under this user's default record type ("Customer"), where no Tomco report will find it |
| `Type` / `BillingStreet` … | from the Command Center account when present | optional; blank is fine |

🔴 **`Account.Corporate_Name__c` DOES NOT EXIST** (`describe`, 2026-10-14). An
earlier version of this table told us to write it. The field is on Opportunity
and WorkOrder only — so an Account created by the write-back carries **no Tomco
marker at all**, and Tomco's own account list is derived through its
opportunities. Nothing to fix; just do not write a field that isn't there.

🔴 **`Account.UniqueExternalId__c` does not exist either** — confirmed absent in
production, which is why the create below is the one step in the whole sequence
with no external key. See the ask to Katie at the end of this section.

🔴 **Resolve both record type ids by developer name at runtime.** The two
Tomco ids differ by one character and sit on different objects; a copy-paste
between them produces `INVALID_CROSS_REFERENCE_KEY` at best and a
wrong-record-type Account at worst.

**What it must NOT do is guess at near matches.** A `LIKE '%Vision%'` search
returns *Envision Construction*, *MegaVision HVAC*, *PPP Commercial Division*
and seven LABOR DIVISIONs before it reaches the right record — and with a LIMIT
it never reaches it at all. (That mistake was made while writing this section:
the first probe reported "Vision General Contractors" as new because the limit
truncated the real match away.) Substring matching on company names is how one
GC's work ends up split across two accounts.

> **Worth asking Katie for:** `UniqueExternalId__c` on **Account** as well. She
> added it to Opportunity on 2026-10-13; the same field on Account would make
> the create idempotent instead of relying on a name lookup immediately before
> the insert. Two new GCs a month is low volume, so this is a small risk — but
> it is the only create in the sequence with no external key behind it.

### 2b. The Quote — MATCH FIRST, for the same reason as §4

A paired Opportunity **already has a Quote**, with the right money on it. Both
twins in the first payload do:

```
006Wj00000qbgLhIAI  Cummins -Interior   → 0Q0Wj000007K4HyKAK  "Quote Sent"  $5,150
006Wj00000nNN1JIAW  Facade Renov-Eastp. → 0Q0Wj000006oOq5KAE  "Quote Sent"  $9,350
```

And that is the org's normal shape, not a coincidence — across Tomco's 186
quotes, `Estimate Sent / Quote Sent` is **31** and `Closed Won / Approved` is
**82**. Winning a Tomco job in Salesforce *flips the existing quote* from
`Quote Sent` to `Approved`. It does not add a second one.

```
query Quote WHERE OpportunityId = <the opportunity>
  exactly one   → UPDATE it: Status → 'Approved', and correct its line (§2c)
  none          → INSERT one
  more than one → STOP and ask; which quote is the sale is not ours to decide
```

**So on a paired deal we create nothing** — we approve what Mary already built,
and fix the number if it moved. The PCCI deal is exactly that case: Salesforce
holds the $9,350 estimate, the job sold at $8,900, and a second quote would make
the account page unreadable.

| Field | Value | Note |
|---|---|---|
| `Name` | see the source note below | ★ required, **255 chars** (unlike Opportunity's 120) |
| `OpportunityId` | the Opportunity from §2a | ★ required; `updateable=1`, but **never repoint an existing quote** |
| `Status` | `'Approved'` | one of `Draft · Quote Sent · Approved · Rejected` |
| `Pricebook2Id` | the "Tomco" pricebook | **load-bearing, not optional** — see 2c |
| `RecordTypeId` | **do not send** | `Quote_SetRecordType_Tomco` sets it |
| `ExpirationDate`, `Description`, `ContactId` | optional | |
| **leave alone on update** | `Name`, `Pricebook2Id` | Mary's name for the job is the one her reports show; renaming her quote is a change nobody asked for |

#### 🔴 `Quote.Name` — the earlier draft named a column that does not exist

It said "the proposal's title". **`commercial_proposals` has no `title`
column** (verified against `055_commercial_proposals.sql` and every later
`ALTER`). The columns that can stand in for a name are:

| Source | Shape | Coverage |
|---|---|---|
| `header_json->>'project_name'` | the human project name, e.g. `"Eastport Facade Renovation"` | **21 of 21** live proposals populated, max 53 chars |
| `proposal_seq` | the number, rendered `PROP-0000` by `proposalLabel()` at `lib/commercial/proposals/db.ts:177` | the stable identifier |
| `commercial_opportunities.title_override ?? title` | the deal name | 98 of 98 sold deals, max **79** chars |

**The rule:** `header_json->>'project_name'` when a proposal exists, else the
deal title; truncate to 255 (never reached in practice). And **all four deals in
the first payload have a proposal** — PROP-3060, PROP-3059, PROP-3061, PROP-2693
— so the fallback is not exercised on day one.

The "93 of 98 sold deals have no proposal" figure is correct and worth keeping in
view, but it describes the **94 already-imported** deals, which need nothing
(§1). Every deal the write-back actually touches was created here and has one.

⚠️ **`Quote_ErrorWhenOpportunityLost` v3 is a before-save flow on Quote CREATE**,
and its *label* reads "Quote.ErrorWhenOpportunityClosed". We insert a Quote under
an Opportunity we have just set to **Closed Won**. The body is unreadable. **This
is the most likely first-attempt rejection in the whole sequence** — someone must
open that one flow in Setup before the first write.

⚠️ `Quote_CalculateTax` v16 adds `Tax` on save — the rehearsal produced $8,761.12
on a $100,127.09 contract. Expected, not a defect, but Katie should know the
Quote's `GrandTotal__c` is tax-inclusive while the contract figure is not.

Setting `Status = 'Approved'` is what closes the sale: an active flow moves the
Opportunity to Closed Won. **So the write-back approves the Quote and lets the
org set the stage.**

#### 2c. The line item, and why it is one placeholder row

`QuoteLineItem` requires `QuoteId`, `PricebookEntryId`, `Product2Id` and
`Quantity` — a product catalogue Tomco's free-text proposals have no equivalent
for. That looked like the hard part of this feature until the data settled it.

**Measured across all 186 Tomco quotes / 191 lines, 2026-10-14:**

```
lines per quote:   0 → 2 quotes    1 → 180    2 → 2    3 → 1    4 → 1
product:           "Other" on 191 of 191
PriceOverride__c:  true on 191 of 191
UnitPrice:         $500 on 189, $0 on 2
TotalPrice__c == PriceOverrideAmount__c on 191 of 191   ← the formula, confirmed
```

An earlier draft said **"exactly ONE line item"** on every quote. Close, not
true: **180 of 186**. Four quotes are itemised (2–4 lines, e.g. Boyce at
$2,425 + $7,500 + $2,275 + $4,500) and two carry no line at all. The one-line
shape is the convention to *write*, but it is not a shape to *assume when
reading* — see the update rule below.

So the line is a token, not an itemisation — and it is where
`Opportunity.Amount = $500` comes from on every Tomco deal, which this document
flagged as a mystery in §0b and is now explained.

Match their convention rather than inventing a better one — but **resolve the
ids at runtime, never hardcode them**:

| Field | Value | Note |
|---|---|---|
| `QuoteId` | the Quote | ★ required, **create-only** |
| `Product2Id` | "Other" | ★ required. prod `01t6g000007bqPaAAI`; the id survives into the sandbox, but **10 active products are named "Other"** there — resolve via the PricebookEntry, not by name |
| `PricebookEntryId` | the "Other" entry in the Quote's OWN pricebook | ★ required, **create-only** |
| `Quantity` | `1` | ★ required |
| `UnitPrice` | `500` | the placeholder; 189 of 191 Tomco lines |
| `PriceOverride__c` | `true` | **boolean** — the switch that makes the next row the price |
| `PriceOverrideAmount__c` | **the contract base, in dollars** | 🔴 **THE ONLY MONEY FIELD WE WRITE ANYWHERE.** §2⁰ |
| **never write** | `TotalPrice__c` | **FORMULA, `createable=0`** — a draft wrote it and earned `INVALID_FIELD_FOR_INSERT_UPDATE` |

#### The line on a PAIRED deal — update, don't add

A paired Opportunity's Quote already has its line, carrying the estimate's
price. The sold price may differ (PCCI: $9,350 estimated, $8,900 sold).

```
lines on the matched quote:
  exactly one   → UPDATE PriceOverrideAmount__c to the sold contract base.
                  Leave Quantity, UnitPrice, Product2Id, PricebookEntryId alone.
  none          → INSERT one, per the table above
  more than one → 🔴 STOP and ask. Four Tomco quotes are itemised; spreading one
                  contract figure across them, or collapsing them to one line,
                  both destroy Mary's breakdown. A human decides.
```

🔴 **`PricebookEntryId` and `Product2Id` are `createable` but not `updateable`
on QuoteLineItem** — which is exactly what we want: the update branch physically
cannot repoint the line at a different product or pricebook.

🔴 **The PricebookEntry is pricebook-specific and cannot be a constant.**
`01uKf000003rzzJIAQ` belongs to pricebook `01sKf000000hGWlIAM` ("Tomco"). A Quote
inherits `Pricebook2Id` from its Opportunity, and the line must reference an entry
in **that** book. Measured on Tomco opportunities: 194 in "Tomco", **2 in "CA, FL"**
(whose "Other" entry is **$0**), and **2 with no pricebook at all**. The same
product is $750 in NYC and Brooklyn/Queens.

That id also **does not exist in the sandbox** — the equivalent is
`01uDG00000EMZWQYA5`. So: set `Pricebook2Id` explicitly on the Opportunity and
the Quote, then look up the "Other" entry **in that book** at runtime.

### 2d. A change order approved here — CONFIRMED IN SCOPE (Karan, 2026-10-13)

Without this, Katie's total is short by every change order Tomco raises from now on.

**Salesforce holds change orders as real records, not a number.** `ChangeOrder__c`
is createable and updateable, hangs off the WorkOrder, and
`WorkOrder.TotalChangeOrder__c` is a **rollup over it** (formula, not writable) which
in turn feeds `Quoted_Subtotal_with_Change_Order__c` and then the Opportunity via
`WorkOrder_SetOpportunityFinancialFields`.

**That is the whole mechanism, and it means we never write a money field at all.**
Create the change order; Salesforce's own arithmetic carries it up to the sales
figure Katie reads. This works *with* the org instead of fighting the
last-writer-wins flow that would otherwise overwrite anything we set on the
Opportunity.

#### `ChangeOrder__c` field map (from `describe`, verified)

| Field | Type | Notes |
|---|---|---|
| `WorkOrder__c` | reference | **★ REQUIRED**, create-only — the job |
| `CostChange__c` | currency | the amount (positive; a deduct is negative) |
| `Status__c` | picklist | `New` · `Approved` · `Denied` · `Pending Approval` · `Approved-Auto` · `Legacy Import (Approved)` · `Pending` |
| `ReasonForChange__c` | picklist | `Scope change` · `Scope increase` · `Scope reduction` · `Client changed mind` · `Material not available` · `Crew not available` · `Other` |
| `ReasonForChangeOther__c` | string | free text when reason is Other |
| `Notes__c` | textarea | our CO title + description |
| `LegacyId__c` | string(18) | **externalId + unique — but IN USE on 13,915 of 19,090 records.** Do not reuse. |

**Only `Approved` (and `Approved-Auto`) count toward the rollup**, so status is the
load-bearing field, not just a label.

#### What actually needs to move — measured 2026-10-13

Salesforce already holds **43** Tomco change orders; Command Center holds **30** live.
**21 match by amount.** The rest:

**Two are status disagreements, and they ARE two of the four contract gaps** —
Salesforce has the change order but has not approved it, so it is outside the rollup:

```
5150 Vet Mem Hwy  $5,200.00   ours approved · SF "Pending Approval" (CO-32564)
DuCon TENANT        $865.70   ours approved · SF "Pending Approval" (CO-32246)
```

These need **updating, not creating** — set `Status__c = 'Approved'`.

**Two approved change orders genuinely do not exist in Salesforce:**

```
Green Leaf "Drip Caps"          $550.00
McDonald's "Bathroom Ceiling"   $450.00
```

Three more raised here are still `pending` (Creative Biolabs ×3) and must not sync
until approved.

#### 🔴 "Unmapped means new" is WRONG — and it would inflate a live contract

An earlier draft said: a rollup carries an import-map row, anything raised here
does not, so **push every unmapped approved change order**. Measured, that rule
is wrong for most of the population. Command Center holds 12 change orders with
no map row, and Salesforce **already holds the same change order** for seven:

| Command Center (unmapped) | Salesforce already has |
|---|---|
| McDonald's Coram CO-1 **$1,150 approved** | **CO-32573 $1,150 Approved** ← pushing this takes SF from $22,650 to $23,800 |
| 5150 Vet Mem CO-1 $5,200 approved | CO-32564 $5,200 Pending Approval |
| DuCon TENANT CO-1 $865.70 approved | CO-32246 $865.70 Pending Approval |
| Water Lillies CO-2 $23,050 pending | CO-32562 $23,050 Pending Approval |
| Water Lillies CO-3 $11,570 pending | CO-32434 $11,570 Pending Approval |
| Creative Biolabs CO-2 $650 pending | CO-32561 $650 Pending Approval |
| 1 Rodeo Drive CO-2 $3,950 declined | CO-32538 $3,950 **Denied** |

Import-map presence answers "did we import this", not "does Salesforce have
this". The importer's own docblock says the McDonald's $1,150 is *the same change
order entered in both systems* — and the write-back's rule could not see it.

**Genuinely absent from Salesforce: two.** Green Leaf "Drip Caps" $550 and
McDonald's "Bathroom Ceiling" $450.

**The rule instead:** query `ChangeOrder__c` on the parent WorkOrder, match on
amount, and
- amount present and `Status__c` not Approved → **update the status**, do not create
- amount present and already Approved → **do nothing**
- amount absent → create
- **two COs at the same amount** → stop and ask; no key can tell "entered twice"
  from "two genuine COs for the same amount", and that case is already live

The synthetic rollup rows (`entity='change_order'` in the map, titled "Approved
change orders") are never pushed under any circumstances — LMJ Cipla's single
$31,127.09 row stands for **seven** Salesforce records.

#### `ChangeOrder__c` field map — corrected

| Field | Value | `describe` 2026-10-14 | Note |
|---|---|---|---|
| `WorkOrder__c` | the job's SF work order | `nillable=0 create=1 update=0` | ★ genuinely required, **create-only**, and §2f says we may not be able to create one |
| `CostChange__c` | signed amount | `nillable=1 create=1 update=1` | negatives are fine — the org has 4,590 and Tomco one |
| `Status__c` | `'Approved'` | `nillable=0` **but `defaultedOnCreate=1`, default `Pending`** | **NOT API-required** — omitting it yields `Pending`, which is outside the rollup, so it is *load-bearing* rather than *required*. Send it deliberately |
| `ReasonForChange__c` | see below | `nillable=0` **but `defaultedOnCreate=1`, default `Client changed mind`** | **NOT API-required either** — and the default is actively wrong for a scope add |
| `Notes__c` | our CO title + description | `nillable=1 create=1 update=1` | optional |
| `LegacyId__c` | **do not use** | externalId+unique | in use on 13,915 of **19,090** records |

**Two earlier drafts got the required-ness of these backwards in both
directions** — the first omitted them entirely, the second marked them
`★ REQUIRED`. Neither is right: Salesforce will accept the insert without them
and silently fill in `Pending` / `Client changed mind`. That is worse than a
rejection, because a `Pending` change order is **excluded from the rollup** and
Katie's total is quietly short by its amount, with no error anywhere.

#### 🔴 `ReasonForChange__c` has no source column on our side

`commercial_change_orders` records *what* changed and *how much*, not *why* —
there is no reason field, picklist or free-text, anywhere in that table. So the
value has to be a constant, and the choice is ours to make and Katie's to
approve:

| Candidate | Why |
|---|---|
| **`'Scope change'`** ← recommend | neutral and true of every CO Tomco raises here; the write-back cannot know direction without inferring it from the sign |
| `'Scope increase'` / `'Scope reduction'` | derivable from `sign(amount_cents)`, more informative, but it is an inference we would be presenting as a recorded fact |
| `'Other'` + `ReasonForChangeOther__c` = our CO title | most honest — it says "this came from the Command Center and the reason is the title" — but it makes Tomco's reason breakdown useless in Salesforce reports |
| `'Client changed mind'` | **the default, and a claim about the GC's behaviour we have no evidence for.** Never let this land by omission |

**Put all four to Katie — but as a confirm, not a blocker.** `'Scope change'`
has now been accepted on a real record (above), so the plan works with it
today; what remains is purely which word she wants in her reporting, and she can
override it later without touching anything else. It is still the only field in
this plan where the Command Center holds no answer at all.

### ✅ `Approved` IS CORRECT — settled by experiment, 2026-10-14

`Approved-Auto` is 18,953 of the org's change orders and `Approved` only 45 (27
of them Tomco's), which looked like a flow owning the field — so rather than ask
Katie to guess, `scripts/tomco-writeback-stage0-changeorder.mjs` wrote one
against the Stage 0 work order and read it back:

```
Status__c 'Approved'                    → held. No flow rewrote it
ReasonForChange__c 'Scope change'       → accepted
WorkOrder.TotalChangeOrder__c           $0.00      → $1,111.11
WorkOrder subtotal + CO                 $12,345.67 → $13,456.78
Opportunity CO-inclusive total          $13,456.78
```

So the whole §2d mechanism works end to end on a real record, `Approved` counts
toward the rollup, and **this is no longer a question for Katie.** Probe row
`CO-30604` on `a09Em00000hf8ldIAA`; `ChangeOrder__c` is not deletable by this
user, so it stays in the sandbox.

The four active flows on this object did not interfere with the insert. The
`ChangeOrder_AllowOnlyAuthorizedUsers` flow gates UPDATES specifically, so §2d's
status-update path (the two change orders Salesforce holds as Pending Approval)
is still untested — that is a Stage 4 check, not a Stage 0 one.

⚠️ Four active flows fire on these writes, none readable:
`ChangeOrder_RouteToApproval` v13 (CreateAndUpdate — may submit for approval or
reset the status), `ChangeOrder_AllowOnlyAuthorizedUsers` v3 (**Update-only** —
gates exactly the status updates above; the integration user may not be
authorised), `ChangeOrder_Approval_UpdateLineItems` v6 (creates WorkOrderLineItems),
and `ChangeOrder_SplitPaymentTermsEvenly` v1 (**async after commit** — rewrites
`Payment_Term__c`, of which Tomco has zero, so it no-ops or fails where nobody
sees it).

⚠️ `ChangeOrder__c` is **not deletable** by this user. A wrong change order can
only be superseded, never cleaned up.

---

## 2e. 🔴 WHAT THE NEXT NIGHTLY IMPORT DOES WITH WHAT WE JUST WROTE

Absent from every earlier draft, and it is the highest-risk interaction in the
feature. The write-back pushes a record OUT; the importer pulls it straight back
IN the same night.

`SF.opps` is scoped `Corporate_Name__c='Tomco Painting'` — so our new
Opportunity is in scope. The importer's map is keyed on the **Salesforce 18-char
Id only**; `UniqueExternalId__c` appears nowhere in it. Two outcomes, both bad:

**If the write-back does not record a map row** — `mapped("deal", newId)` is
null, so `stageDeals` plain-INSERTs a **second `commercial_opportunities` row**.
Nothing constrains it. `stageAccounts` does the same for a created Account,
`stageJobs` a second job, `stageInvoices` a second invoice.

**If it does record one** — `put()` takes the update branch, `editedHere()`
compares the row's `updated_at` against the stamp the write-back just wrote,
concludes "not edited", and **Salesforce wins**: `accepted_contract_cents` ← the
$500 of §2⁰, `status`/`sub_status` ← derived from the WorkOrder,
`probability_pct: 100`, `win_loss_debriefed_at: now()`, `bid_value_*: null`, the
WO's address over the deal's, and `created_at` ← the Salesforce CreatedDate,
moving a June sale to October on every date-bucketed report.

**Three things must be true before the first write-back runs:**

1. **The write-back records its map row with a deliberately STALE `updated_at`**
   (epoch). `editedHere` then reads every Command Center row as human-edited, and
   Salesforce never wins during the dual run.
2. **`stageDeals` learns `UniqueExternalId__c`** — an Opportunity carrying one is
   ours; adopt the mapping and leave the row alone rather than re-deriving it
   from Salesforce.
3. **`--salesforce-wins` and `--rebaseline` are forbidden** for the whole dual
   run. Both override the guard above by design.

And one importer bug must be fixed first, because the write-back is what makes
it reachable: `stageChangeOrders` hard-codes `co_number: 1` and has no adoption
lookup, so a second WorkOrder on one Opportunity collides with
`commercial_change_orders_live_number_uidx` and **throws at stage 6 of 14** —
losing payments, costs, attendance, projects, files and dates for that night.

**It is LATENT today, not live — and the distinction matters.** Four Tomco
opportunities do carry two WorkOrders each:

```
006Kf00000N2RNSIA3  00274853 Closed    + 00275191 Canceled
006Wj00000Mt9dtIAB  00279525 Closed    + 00282082 Canceled
006Wj00000NIoynIAD  00280122 Canceled  + 00280498 Closed
006Wj00000ZkoIbIAJ  00306879 Canceled  + 00306902 Canceled
```

In every case one is `Canceled`, and `import-tomco.mjs:432` scopes its
WorkOrder query `AND Status != 'Canceled'` — so **zero** opportunities present
two work orders to the importer, and the collision has never been reached. An
earlier draft reported this as a crash waiting to happen tonight; it is not.

What makes it reachable is the write-back itself: approving a change order runs
`ChangeOrder_Approval_UpdateLineItems` v6, and a second *live* WorkOrder on one
Opportunity is the one state the index cannot survive. **Fix it before §2d
ships, not before §2a.**

## 2f. ✅ SETTLED BY ONE SANDBOX WRITE — 2026-10-14

**Stage 0 ran.** `scripts/tomco-writeback-stage0.mjs --apply`, against
`precisionplus--dev.sandbox.my.salesforce.com`, as
`katie@precisionpaintingplus.com.dev`. One Opportunity + Quote + QuoteLineItem,
quote approved then synced, read back after 8 seconds. Records left in place for
inspection: Opportunity `006Em00000uCH3HIAW`.

| Question | Answer |
|---|---|
| Does the money chain work end to end? | ✅ **Yes.** $12,345.67 went in on `PriceOverrideAmount__c` and came out on `Opportunity.Quote_Subtotal__c`, through all four hops unchanged |
| Does the flow create the WorkOrder? | ✅ **YES — one, `00264207`, status Coordination.** The assumption HOLDS |
| Are `Payment_Term__c` rows created? | ❌ No — zero. That half of the assumption is wrong, and harmless: Tomco has none in production either |
| Does the CO-inclusive total populate? | ✅ **Yes, $12,345.67** — because the WorkOrder exists. §2⁰ predicted NULL; that prediction was wrong in the better direction |
| Quota points written? | ✅ **Zero.** Katie's exclusion holds |
| Email sent to anyone? | ✅ **None.** Katie's exclusion holds |
| `Corporate_Name__c` | 🔴 **"PPP of SW LI LLC", not "Tomco Painting"** — see below |

**What this unblocks.** The WorkOrder is created, so `ChangeOrder__c.WorkOrder__c`
has the parent it requires, and §2d can be built. The CO-inclusive figure Katie
asked for will populate rather than coming out blank. Both of those were open.

### 2f¹. The one that came back wrong, and why it is NOT a defect

`Corporate_Name__c` decides whether the record exists at all — every Tomco query
in Command Center and in `import-tomco.mjs:61` filters on it — so a sale
stamped with the wrong one is invisible to both systems. It came back
`PPP of SW LI LLC`.

Measured in both orgs before concluding anything:

```
PRODUCTION   Brendan Tomco owns 191 opportunities → "Tomco Painting"   191 of 191
SANDBOX      Brendan Tomco owns  29 opportunities → "PPP of SW LI LLC"  29 of 29
             "Tomco Painting" appears on ZERO sandbox records
```

The owner→corporate mapping that yields "Tomco Painting" **does not exist in the
sandbox at all**. Brendan's sandbox user carries the right role (`Tomco`) and
profile (`*Tomco`), so this is stale sandbox configuration rather than anything
our write controls — in production the identical write maps to Tomco Painting,
consistently, on every one of 191 records.

**Two consequences, both of which change how the remaining stages are run:**

1. **The sandbox cannot validate this field.** Every Stage 1–4 rehearsal will
   produce records invisible to Tomco queries over there, and that is expected,
   not a failure. Do not spend time "fixing" it in the sandbox.
2. **The production read-back in §2a³ is therefore load-bearing, not
   belt-and-braces.** It is the only place this can actually be verified. Read
   `Corporate_Name__c` back after every production write and fail loudly if it
   is not `Tomco Painting`.

Worth one line to Katie: the sandbox's corporate-name mapping is stale, which
costs nothing today but means no sandbox rehearsal can prove this particular
field.

### 2f². And a caveat about who the sandbox tests as

The stored sandbox login authenticates as **`katie@precisionpaintingplus.com.dev`**,
not Karan. That is the better identity to rehearse through — but it is still not
proof for §2a¹'s close-date rule, because whether THAT user holds `Admin_Bypass`
in the sandbox has not been checked. The probe set `CloseDate` on an INSERT,
which the rule permits regardless; the rejection only appears on a later UPDATE
of an already-won deal. Stage 2 is where that gets tested, and it must be run
as a user confirmed not to hold the bypass.

## 3. Never write money derived from an invoice

`planInvoiceColumns` **folds tax into the subtotal** when no 3-decimal rate
reproduces Salesforce's tax, and `planInvoice` turns unexplained differences into an
adjustment. Both are deliberate, both lossy, both one-directional. `taxFolded` is
reported at import time and **stored nowhere**, so at write-back time you cannot tell
which invoices were affected. Invoice-derived money is permanently read-only in this
direction.

---

## 4. 🔴 THE BLOCKER: MARY IS STILL CREATING THESE OPPORTUNITIES IN SALESFORCE

An earlier draft called this "the create path needs an external id, which Katie
has not made yet." She has now made it (§0⁻). **The field was never the
problem.** Measured in production 2026-10-14:

```
Tomco opportunities in production                         198
  …carrying UniqueExternalId__c                             0   ← nothing is paired
Tomco opportunities Mary created IN SALESFORCE since 09-01  14   ← incl. 2026-10-14, today
🔴 OPEN (not closed) Tomco opportunities in production      43
```

Tomco's estimates still enter Salesforce by Mary's hand at estimate time, and
enter the Command Center by the estimator's. **The same job exists in both
systems before it is ever sold.** So when the Command Center marks it sold, an
unconditional insert does not create a record — it creates a *twin*, and Katie's
"total sales picture" counts the job twice.

This is not a rare edge case. It is **half of the very first payload**:

| Command Center deal (sold, unmapped) | Production Salesforce | |
|---|---|---|
| Cummins · **$5,150.00** | `006Wj00000qbgLhIAI` "Cummins -Interior" · Estimate Sent · **$5,150** | 🔴 same job, **same cent** |
| PCCI Eastport Facade Renovation · **$8,900.00** | `006Wj00000nNN1JIAW` "Facade Renovation-Eastport" · Estimate Sent · **$9,350** | 🔴 same job, renegotiated down |
| Thermo Fisher Inspection Room & Ext. Door · $5,375.00 | nothing (3 other Thermo jobs, none matching; PO 718210 appears nowhere) | ✅ genuinely new |
| Flagstar Bank Trash Enclosures · $2,400.00 | nothing | ✅ genuinely new |

**And no matcher can do this on its own.** Exact name match misses both twins.
Substring misses the PCCI one. Amount match catches Cummins and misses PCCI,
whose whole point is that the price changed. And Salesforce holds **two
byte-identical `Tesla-Islip` opportunities** Mary created on the same day at the
same $38,030.20 — so even a perfect matcher has no single right answer.

Two further reasons an autonomous create is unsafe, both still true:

- **The map cannot catch a double-create.** `commercial_import_map`'s primary key
  is `(sf_id, entity)` — **not `row_id`** — so a second create for one deal
  inserts a second map row and nothing complains.
- **`writeSf` retries up to 3 times** on anything outside its fatal-error regex,
  and a timed-out create is a network error, so **it retries the create.** Two
  records from one call, before any Id exists to store.

### 4a. So the first step is a PAIRING SCREEN, not a sync

Before any write-back runs, a human pairs each sold-and-unmapped Command Center
deal against the 43 open Salesforce opportunities **once**, and the pairing is
stamped into `UniqueExternalId__c` on the chosen Salesforce record.

```
for each sold Command Center deal with no import-map row:
    show candidates from the 43 open Tomco opps, ranked by
        same Account  ·  amount within 20%  ·  CloseDate within 90 days
    Katie/Mary picks exactly one of:
        “this one”  → write UniqueExternalId__c = our deal id onto THAT record
        “none — new” → mark the deal create-approved
```

After that stamp, the nightly job is **query the external id → found means
UPDATE, not-found means INSERT** (§2a¹), and the insert path is unreachable for
every deal a human has already paired. Four deals today; two of them need a
human's eye. That is twenty minutes of Katie's time, once, and it is the
difference between a correct sales total and a double-counted one.

**This screen is v1.** The nightly sync is v2 and must not ship before it.

### 4b. ✅ ANSWERED — Katie, 2026-10-14: Mary stops creating records in Salesforce

> **Katie:** *"Just want to make sure that moving forward, we'll only sync CCC
> back to SF. I have told Mary to no longer create anything in SF."*

This was about to be put to her as the biggest open question in the plan, and
she settled it unprompted. It is the better of the two options and it changes
the shape of the work:

**Pairing is now a ONE-OFF, not a permanent step.** The 43 open Salesforce
opportunities are a closed set — a backlog, not a growing queue. Every Tomco
deal created from today forward exists only in the Command Center, so the
write-back's INSERT path is correct by construction for all of them.

So the sequence becomes:

```
once      pair the 4 sold-and-unmapped deals against the 43 open SF opps (§4a)
once      and as each of the remaining 39 open estimates sells, pair it too —
          a shrinking list, finished when the last pre-2026-10-14 estimate closes
forever   everything created after 2026-10-14 → plain INSERT, no pairing
```

✅ **CONFIRMED — it covers change orders too.** Katie, 2026-10-14 14:30, asked
whether "nothing in SF" extended past opportunities: *"Yes, I told her to stop
building anything in SF."*

So §2d's match-then-update rule is also a one-off against a closed set, not a
permanent necessity. The 43 Tomco change orders already in Salesforce (7 of them
duplicating ours) still have to be matched rather than re-created — those exist
— but no NEW Salesforce change order will appear to collide with one raised
here. Once the current 43 are reconciled, the change-order step is a plain
create.

⚠️ **And it does not retire the pairing screen early.** 39 open estimates
predate the instruction. Until they are all closed, a deal selling in the
Command Center may still have a Salesforce twin, so the screen stays until that
list is empty — then the INSERT path stands alone.

---

## 5. What firing `Closed Won` actually does

Read from the deployed flows, not from documentation.

**✅ `OnlyLostAfterClosedWon` — confirmed, and it binds us.** The only legal exit from
Closed Won is `Opportunity Lost`. **No admin bypass.** A wrong write cannot be
reverted to its prior stage by anyone.

**✅ `Opportunity_SetCloseDateOnClosedWon` v4, Active, before-save** — overwrites
`CloseDate` with `TODAY()` on the transition and stamps `FY_Assigned__c`. **So the
award date we send is discarded.** PPP's fiscal year runs Feb 1 → Jan 31 and the FY
reports key on that field, so a June sale written in October lands in the wrong
quarter. Either accept it or ask Katie for the one-line flow exemption.

**🔴 `Opportunity_Quota_Points_Record_Creation` v10 — NO ENTRY FILTER.** Every update
to any Opportunity in the org enters it, and it writes **PPP rep compensation**
($1 = 1 point). Its three subflows have not been read by anyone on this engagement.
**Read them before the first write.** This is the one place a Tomco write touches
money PPP pays its own people.

**✅ `Opportunity_SetAccountTypeOnClosedWon` v10** — fires on create, mutates the GC's
`Account.Type` on a shared PPP Account. Real.

### ❌ RETRACTED: the "Let's Get Started" email

An earlier version of this document said marking a deal won would email the GC. **That
is wrong and was reported to Karan as fact — correcting it here.**
`Opportunity_WorkOrderWhenClosedWon` is `recordTriggerType: Update` (it does not run
on insert at all) **and** requires `SyncedQuoteId != null`. A Command Center
opportunity has no Salesforce Quote, so no WorkOrder is created and no email is sent.

**The real risk, which is subtler and worth telling Katie:** our write leaves a sale
in Salesforce **with no job attached**. Mary runs Tomco's back office there. The first
time she adds a WorkOrder to one of those opportunities, the email fires on *her*
insert — for a job that started weeks earlier. The hazard is deferred to a human
action rather than designed out, and Mary should be told what the integration will be
depositing in her queue.

---

## 6. What is still open — and who owns each

### 🔴 Blocking, ours to settle in the sandbox (no one to wait for)

1. ✅ **§2f is answered** — the sandbox write ran on 2026-10-14. The flow does
   create the WorkOrder, the money chain works, and both exclusions hold.
   Nothing is blocked on it any more. The next thing to build is the Stage 1
   pairing screen.
2. **Open the four flows in Setup** — `Quote.ErrorWhenOpportunityClosed`,
   `ChangeOrder:AllowOnlyAuthorizedUsers`, `Opportunity.Hatch Campaign Initial
   Trigger`, `WorkOrder.SendLetsGetStartedEmail`. All four return
   `INSUFFICIENT_ACCESS` to the API; all four are readable in the Setup UI.
3. **Fix the `co_number: 1` collision** before §2d ships (§2e).

### 🔴 Blocking, Katie's call

4. **`ReasonForChange__c`** — four candidates in §2d, no source column on our
   side, and the Salesforce default (`Client changed mind`) is a claim about her
   GCs we cannot support.
5. ✅ **ANSWERED — `Approved` is correct.** Written on a real sandbox change
   order 2026-10-14: the value held, no flow rewrote it, and the rollup moved by
   exactly the amount. §2d. Nothing needed from Katie.
6. 🟡 **IN PROGRESS — Katie, 2026-10-14: "Adding that field now."**
   `Account.UniqueExternalId__c` was absent in both orgs when re-checked that
   afternoon. Verify it exists and is `externalId + unique` before Stage 3
   relies on it; until then the Account create still falls back to the
   exact-name lookup in §2a².
7. ✅ **ANSWERED — accept today's date.** Katie, 2026-10-14: *"If the sync
   happens regularly, then the Close Date should match the date that it's
   created."* Correct, and it costs nothing even for the backlog: every deal in
   the first payload was sold in October and is being written in October, so
   **0 of 5 change fiscal quarter** (checked against PPP's Feb–Jan year rather
   than assumed). `Close_Date_Uneditable_after_Closed_Won_L` stays active and
   we stop trying to work around it — which also removes the §2a¹ worry about
   testing as a user with `Admin_Bypass`, since we no longer send the field on
   an update at all.

### 🟡 Worth telling her, not blocking

8. **MotorMindz- TLA is $30,000 of sold work missing from her Salesforce total**
    (§1). Won in the Command Center 2026-10-08; Salesforce still shows it as
    Estimate Sent with a CloseDate of 2026-08-05 — which is the ESTIMATED close
    on the open opportunity, not a sold date. An earlier draft read that as
    "missing since August"; it has been missing since 8 October.
9. **Quote tax**: `Quote_CalculateTax` v16 makes `GrandTotal__c` tax-inclusive
    while the contract figure is not (§2b).
10. **Tomco is already in PPP's residential dashboard** — ~$2.01M, ~9% of
    "Revenue Sold", and Brendan is on the rep leaderboard against the
    residential field team (§8). The revenue half may be what she wants; the
    leaderboard half almost certainly is not.

### ✅ Answered since the last draft — do not re-ask

- **Does Mary keep creating Tomco records in Salesforce?** No — Katie instructed
  her to stop, 2026-10-14, and confirmed the same afternoon that it covers
  **everything**, not just opportunities: *"Yes, I told her to stop building
  anything in SF."* §4b. So both the opportunity pairing AND the change-order
  matching are one-offs against closed sets rather than permanent steps.

- **The external id** — created in both orgs 2026-10-13. But see §4: the field
  was never the blocker.
- **The quota-points flow** — now excludes Tomco. Verify on the first write;
  do not re-read the subflows.
- **The "Let's Get Started" email** — now excludes Tomco opportunities, so the
  Quote can be synced normally. §0⁻.
- **Do change orders sync?** Karan confirmed in scope, 2026-10-13. §2d.
- **Which identity ships?** ⚠️ Still worth care rather than a decision: the
  connection authenticates as Karan's own user, which holds `Admin_Bypass`, so
  five of the org's ten validation rules skip for it — including
  `Close_Date_Uneditable_after_Closed_Won_L`. **Every rehearsal must be run as a
  user without the bypass, or it proves nothing.**

---

## 7. Infrastructure that must be scoped first

Unchanged from the earlier draft and all verified:

- **`clearSalesforceCache()`** would cold-start PPP's dashboard on every Tomco write
  (8-15s, ~90 SOQL calls, warm cron only at 06:00). Already gated on
  `deferCacheInvalidation`; set it.
- **`alertMaterialsFailure()`** would page Kate's residential materials Slack. Route
  Tomco failures to `COMMERCIAL_INCIDENT_SLACK_WEBHOOK` instead. Expect this to fire
  routinely: any `StageName` change re-runs ZIP→Service-Territory validation, and
  commercial GC addresses are exactly the population that fails it.
- **`sf_writes_audit`** — give Tomco its own `SfWriteSource`; never reuse
  `admin_manual` or `system_resync`.
- **Code location**: `lib/salesforce/tomco.ts`, not `lib/commercial/` — the latter is
  banned from importing `lib/salesforce/*`, and `check-sf-fields.mjs` only scans
  `lib/salesforce`.

## 8. A live bug this work uncovered, unrelated to the write-back

**PPP's residential dashboard is already counting Tomco.** No snapshot query filters
`Corporate_Name__c` — it appears nowhere in `lib/` or `app/`. Measured: **160 Tomco
opportunities and 69 work orders inside the 365-day snapshot window, ~$2.01M, about
9% of the "Revenue Sold" figure on Alex's dashboard** — and Brendan Tomco sits on the
rep leaderboard against the residential field team, because `FIELD_REP_PROFILES`
explicitly includes `*tomco`.

Given Katie wants a "total sales picture," the revenue half may be intended. The
leaderboard half almost certainly is not. Worth asking rather than assuming.

---

## 9. THE BUILD ORDER — sandbox first, Katie checks, then production

Karan, 2026-10-14: *"we build first in sandbox, Katie checks it, then we do in
Salesforce — but before we do this we need to be 100 percent sure and no edge
cases."*

Each stage below has an **exit test that can fail**. A stage is not done because
the code ran; it is done because the test came back with the number it should.

### Stage 0 — ✅ DONE, 2026-10-14. Results in §2f.

Ran `scripts/tomco-writeback-stage0.mjs --apply` against the sandbox. The money
chain works end to end, the flow DOES create the WorkOrder (so §2d has its
parent and the CO-inclusive total populates), and both of Katie's exclusions
hold — zero quota points, no email. The only check that failed,
`Corporate_Name__c`, is a stale sandbox mapping rather than a defect: in
production Brendan's 191 opportunities all carry "Tomco Painting" and the
sandbox has the string on no record at all.

Re-runnable, and it cleans up after itself with `--cleanup`.

### Stage 1 — the pairing screen. Our side only. No Salesforce writes.

§4a. Read-only against Salesforce: list the sold-and-unmapped deals beside the
43 open Tomco opportunities, ranked. Katie or Mary picks. The pick writes
`UniqueExternalId__c` onto the chosen Salesforce record — that is the *only*
Salesforce write in this stage, and it is a single field on a record a human
just pointed at.

**Exit test:** all 4 of today's deals resolved — 2 paired, 2 marked new — and
`SELECT COUNT() FROM Opportunity WHERE Corporate_Name__c='Tomco Painting' AND
UniqueExternalId__c != null` returns exactly the number of pairings made.

### Stage 2 — the UPDATE path only. Sandbox, then production.

No inserts of any kind. Walk the paired deals and update stage, owner and the
quote line's `PriceOverrideAmount__c`.

**Start with MotorMindz- TLA** (§1). It is already paired, needs no account
match and no new quote, and it is a genuine $30,000 correction — so a successful
write is visible to Katie as a *fix*, not as a risk.

**Exit test:** `npm run recon` (the three-dimension reconciliation) still reports
**COST 1:1**, and the contract dimension improves rather than degrades. Run it
before and after and diff the two outputs.

### Stage 3 — the INSERT path. Sandbox only, until Katie signs off.

The two genuinely-new deals (Thermo Fisher, Flagstar), plus the Account create
for Afton Electrical and Doherty Enterprises. This is the first stage that can
create a record nobody asked for, and §4's twin problem is why it is last.

**Exit test:** in the sandbox, count Tomco opportunities before and after. The
delta must equal the number of deals marked "new" in Stage 1 — **exactly**, not
approximately. Then read `Corporate_Name__c` and `RecordTypeId` back on every
created record (§2a³, §2a²).

### Stage 4 — change orders. Only if Stage 0 produced a WorkOrder.

§2d. Update the two `Pending Approval` change orders to `Approved`; create the
two that are genuinely absent (Green Leaf $550, McDonald's $450). Fix the
`co_number: 1` collision (§2e) before this stage, not before Stage 2.

**Exit test:** the four remaining contract differences in the reconciliation go
to zero, and `WorkOrder.TotalChangeOrder__c` moves by exactly $2,065.70.

### Stage 5 — nightly. Only after Katie has looked at Stages 2–4 in the sandbox.

And on the first production night, §2e's three preconditions must already be
true: the map row written with a stale `updated_at`, `stageDeals` taught to
recognise `UniqueExternalId__c`, and `--salesforce-wins` / `--rebaseline`
forbidden for the whole dual run.

### What "100 percent sure" means here, concretely

The honest answer is that **Stage 0 is the only thing standing between this plan
and certainty**, and it is one write. Everything above Stage 0 in this document
is measured against production as of 2026-10-14 — field types, record ids,
picklist defaults, row counts, the money chain, the twins. Everything that
depends on §2f is marked as depending on it.

What this plan does **not** claim:

- That `Approved` is the right change-order status — Katie's call (§6.6).
- That the WorkOrder flow fires — unverified, Stage 0 (§2f).
- That `QuotedSubtotalWithChangeOrder__c` will populate for our deals. It will
  not, unless Stage 0 produces a WorkOrder. Katie's CO-inclusive figure comes
  out **blank rather than wrong**, and she should know which (§2⁰).
