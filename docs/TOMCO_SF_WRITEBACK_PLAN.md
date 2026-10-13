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

> Companion document: `docs/SALESFORCE_WRITEBACK_QUESTIONS_FOR_KATIE.md` (2026-09-22)
> carries **Katie's answers** — record types, ownership, close-date policy. Read it
> first; do not re-ask what she has already settled. Still open there: **Q2**, the
> `CCC_Id__c` external id. §4 below makes it a hard prerequisite rather than an option.

---

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

## 1. 🔴 THE 93 EXISTING DEALS NEED NOTHING. Writing to them does damage.

The earlier draft proposed writing four fields across all 98 sold deals. Measured
against production, that would have been actively harmful:

**`StageName` is already `Closed Won` on all 93 linked deals.** Writing the value a
record already holds is not a change — so `ISCHANGED(StageName)` is false, which
means `Close_Date_Uneditable_after_Closed_Won_L` fires and **rejects the entire
update**. Fields 1 and 3 of the old four-field plan are inert here.

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

**Conclusion: there is no backfill.** The 93 deals came *out* of Salesforce and
Salesforce still holds them correctly. The write-back exists for what happens next.

---

## 2. What actually needs to go to Salesforce

Two things, and only two:

### 2a. A sale made in Command Center that Salesforce has never seen

A new Opportunity, `Closed Won`, carrying the contract value. This is the feature.

Required on create (from `describe`, verified): **`Name`, `StageName`, `CloseDate`**
— nothing else. Plus, per Katie's answers: `RecordTypeId = 012Kf000000L8Q6IAK`
(Tomco), `OwnerId = 005Kf0000021SPzIAM` (Brendan — which also drives
`Corporate_Name__c` through an active flow), `AccountId`, and the money field.

**The money field is `QuotedSubtotalWithChangeOrder__c`, and it must be the
CO-inclusive figure** — the same ladder every Command Center screen displays
(`pickContractBaseCents(...) + netApproved`), **never** `contract_base_cents` alone
(§1) and never an invoice column (§3).

`Amount` is left alone: it is hardcoded $500 on essentially every Tomco won deal and
no PPP report reads it.

### 2b. A change order approved here, on a deal Salesforce already has

Four of these exist today and they are exactly the contract differences the
reconciliation cannot close:

```
5150 Vet Mem Hwy   +$5,200.00
DuCon TENANT         +$865.70
Green Leaf           +$550.00
McDonald's Coram     +$450.00
```

Without this, Katie's "total sales picture" is short by every change order Tomco
raises from now on. **This is a real decision, not an omission** — see §6 Q2.

---

## 3. Never write money derived from an invoice

`planInvoiceColumns` **folds tax into the subtotal** when no 3-decimal rate
reproduces Salesforce's tax, and `planInvoice` turns unexplained differences into an
adjustment. Both are deliberate, both lossy, both one-directional. `taxFolded` is
reported at import time and **stored nowhere**, so at write-back time you cannot tell
which invoices were affected. Invoice-derived money is permanently read-only in this
direction.

---

## 4. 🔴 v1 MUST NOT CREATE until `CCC_Id__c` exists

The earlier draft offered a fallback: create, store the returned Id immediately,
check Salesforce for a match first. All three halves fail.

**The map cannot enforce it.** `commercial_import_map`'s primary key is
`(sf_id, entity)` — **not `row_id`** — so a second create for the same deal inserts a
second row and nothing complains.

**The retry window is wider than "the response is lost."** `writeSf` retries up to 3
times on anything not matching its fatal-error regex, and a timed-out create is a
network error — **so it retries the create**. Two records, inside one call, before any
Id exists to store.

**Matching by name cannot work here, and the data proves it.** Both near-duplicates
are live:

```
CCC "Cummins-Interior"  $5,150  ↔  SF "Cummins -Interior"  $5,150  (Mary, 09-30)
CCC "PCCI … Eastport Facade Renovation" $8,900 ↔ SF "Facade Renovation-Eastport" $9,350
```

Exact match misses both. Substring misses the second. And Salesforce already contains
**two identical `Tesla-Islip` opportunities** Mary created the same day, so "find the
matching opportunity" has no single right answer across 43 open Tomco opps.

**So: `CCC_Id__c` (External ID, Unique) is a prerequisite, and the create path is
`upsert` on it.** Until Katie creates that field, v1 updates only and reports the
sales it could not push.

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

## 6. Open questions

1. **Read the three quota-point subflows.** Blocking. §5.
2. **Do change orders sync?** If not, Katie's total excludes every CO Tomco raises —
   currently ~$198k across the book. If yes, each one re-enters the unfiltered quota
   flow. Her call, and she needs both halves to decide.
3. **`CCC_Id__c`** — still unanswered from 2026-09-22, now a prerequisite (§4).
4. **CloseDate**: accept `TODAY()`, or ask for the flow exemption so the award date
   survives?
5. **Which identity ships?** The connection authenticates as Karan's own user, which
   holds `Admin_Bypass` — five of the org's ten validation rules skip for it. Anything
   tested through it passes guardrails a real integration user would hit.

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
