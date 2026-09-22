# Salesforce write-back — everything we need from Katie

Katie — I've read the org rather than guessed, so most of these are "confirm this" rather
than open questions. Three of them are genuine blockers and I've put those first.

**What we're building:** a CCC sale creates/updates an Account, a Closed Won Opportunity,
and an Interior Painting Work Order in **PPP's production Salesforce** (`Precision+` —
there's only one org; Tomco's records live inside it as a record type).

---

## 🚩 Three blockers

### 1. A validation rule blocks the main thing you asked for

You asked for the Close Date to sync from CCC. The org has an **active** rule:

> `Close_Date_Uneditable_after_Closed_Won_L` — *"Contact PPP Support for assistance."*

**Close Date can't be changed once an Opportunity is Closed Won.** All 132 deals we'd be
updating are already Closed Won, so every close-date update will be rejected.

**Which do you want?**

- **(a)** Exempt the integration user from that rule (usual approach: add
  `AND NOT($User.Id = '<integration user>')`, or a `Bypass_Validation__c` checkbox on User)
- **(b)** Close Date is set **only on create**, and never corrected afterwards
- **(c)** Something else you'd prefer as the admin

There's a second one, `OnlyLostAfterClosedWon`, which constrains stage moves — relevant
only if a CCC deal can be un-won (see Q11).

### 2. We need a new External ID field — `LegacyId__c` is taken

To never create duplicates, each Salesforce record needs to carry its Command Center id.
That makes the sync an **upsert**, which is idempotent and safe to re-run.

`LegacyId__c` already exists as a unique External ID on all three objects, but it's in
use (50,592 Accounts / 47,794 Opportunities / 39,225 Work Orders), so we mustn't touch it.

**Please create, on Account, Opportunity and Work Order:**

| | |
|---|---|
| Field label | `Command Center ID` |
| API name | `CCC_Id__c` |
| Type | Text (36) |
| **External ID** | ✅ yes |
| **Unique** | ✅ yes |
| Visible to | the integration user (+ admins) |

> ⚠️ Note `WorkOrder.Command_Center__c` already exists — it's a formula that renders a
> *link* back to the hub, it's read-only, and it's on all 95,896 work orders. Different
> thing. We shouldn't reuse or disturb it.

### 3. A dedicated integration user — not Karan's login

The integration currently connects as **`malhotrak038@gmail.com`**. Left as-is, every
record it creates in production is owned by and attributed to Karan, which breaks
rep-level reporting and the audit trail.

**Please create an integration user** (e.g. `commandcenter@precisionpaintingplus.com`)
with a permission set granting:

- Create + Edit on **Account**, **Opportunity**, **Work Order**
- Access to the **record types** we settle on in Q4
- **Read/Write on `CCC_Id__c`**
- API Enabled

And — **is there a sandbox we can point at first?** A `dev` sandbox has been mentioned
before. The first real write should not happen in an org with 95,434 live opportunities
if it can happen somewhere else.

> ⚠️ **One Work Order concern:** when we asked Salesforce which Work Order record types
> our current user can use, it returned **none** — yet real Tomco work orders carry
> `012Kf000000L8Q8IAK`. If the integration user can't access that record type, every work
> order we create lands on the wrong one or fails. Worth checking when you set up the
> permission set.

---

## Decisions (quick ones)

**4. Record type — Tomco, or standard PPP?**
"Write to PPP's Salesforce, not Tomco's" reads two ways, and it's expensive to reverse
(drives layouts, picklists, validation, automation, reporting).

- **(a)** Tomco record types — Account `012Kf000000L8Q5IAK`, Opportunity
  `012Kf000000L8Q6IAK`. Consistent with the 188 Tomco opps already there; keeps Tomco
  separable in reporting. ← *our assumption unless you say otherwise*
- **(b)** Standard PPP — Account `Customer`, Opportunity `New`. Tomco sales blend into
  PPP's main pipeline.

**5. `Amount` vs `QuotedSubtotalWithChangeOrder__c`**
On the deal we sampled, `Amount` = **$500** and `QuotedSubtotalWithChangeOrder__c` =
**$21,328.40**. Since every PPP report reads the latter, we'd put the contract value
there. **What should `Amount` hold — the same number, or leave it alone?**

**6. What `Status` should a new Work Order start in?**
Real Tomco work orders use `Work In Progress`, `Complete Balance Owed`, etc. Note several
active rules gate *completion* — `Start_End_Dates_Required_to_Complete`,
`Add_Assigned_Labor_Crew`, `Undeposted_PaymentIn_Cannot_be_Complete`,
`Jeremys_Team_Attendance_Required` — so we should start somewhere safely short of
Complete.

**7. Is Work Type always `Interior Painting`?**
You specified it, and it exists (`08q6g000000dTxNAAU`). But Tomco does exterior work too,
and CCC doesn't currently record a work type. **Always Interior Painting, or should CCC
start capturing it?**

**8. Who owns the records the sync creates?** The integration user, a specific Tomco rep,
or Brendan? This drives rep-level reporting.

**9. Do `LeadSource` / `LeadGroup__c` / `Type` need values?** All three were empty on the
Tomco deal we looked at. If your reporting buckets on lead source, an empty value may put
these in the wrong bucket.

---

## Behaviour (the rules that prevent surprises later)

**10. Which CCC deals sync, and when?**
Our assumption: any deal that reaches **won or beyond** (won / pre-construction /
in-progress / billing / closed-out) — currently **94 deals**. Pushed on the nightly run.
**Confirm, or narrow it.**

**11. What happens if a deal is un-won in CCC?**
Should the Salesforce Opportunity move out of Closed Won (which `OnlyLostAfterClosedWon`
constrains), or should we refuse and flag it for a human? **Our recommendation: refuse
and flag** — automated un-winning in production is how bad things happen quietly.

**12. If a deal is edited in BOTH systems, which wins?**
Today the sync is one-way and Command Center always wins. Write-back creates the opposite
collision. **Our recommendation: CCC wins for deals it owns, and anything else is
reported rather than silently resolved.**

**13. What if a CCC deal is deleted?** Delete in Salesforce, mark it Lost, or leave it and
flag? **Our recommendation: never auto-delete in production.**

**14. New accounts — how should we match before creating?**
75 of our 76 accounts already carry a Salesforce id, so those are exact. For genuinely
new ones, matching on company name is fragile (*Above All Services* vs *Above All
Services Inc.* creates a duplicate GC). **Our recommendation: exact name match → use it;
anything close but not exact → stop and ask a human.** Do you have a preferred matching
rule, or a dedupe tool we should respect?

**15. Just these three objects — or more?**
You listed Account, Opportunity, Work Order. CCC also holds invoices, payments, change
orders and costs, which today flow Salesforce → CCC. **Do any of those need to go back
the other way, or is it only the sale?**

**16. Who should hear about failures?** When a write fails validation, who gets the
email — you, Brendan, or a shared inbox?

---

## For your awareness (no answer needed)

- **Nobody has entered a sale in Command Center yet** — all 132 deals came out of
  Salesforce. So this builds for what's coming, plus the 132 back-updates you asked for.
- **Creating Closed Won opportunities may fire automation** — commissions, quota credit,
  rep notifications. We can't see flows from the API. If anything fires on Closed Won
  creation, we should know before we create 94 of them.
- Our contract total ties to Salesforce **to the cent** ($2,676,983.67), so the two
  systems agree today — a good baseline to sync from.
- We'll run in **dry-run first**, capped, and log every write with its Salesforce id so
  anything wrong can be found and undone.

---

### The short version

**Blocking:** ① the Close Date validation rule, ② a `CCC_Id__c` External ID field on the
three objects, ③ an integration user with record-type access (+ a sandbox if there is one).

**Then:** record type (Q4), `Amount` (Q5), Work Order status (Q6), owner (Q8).

Everything else has a sensible default we've proposed — tell us where you disagree.
