# Tomco → Salesforce write-back (SOLD only)

Katie, 2026-10-13: *"we need to write back to salesforce for tomco only dont mix it
with PPP … whenever we write in the commercial platform it should immediately write
back into their salesforce … keep in mind the progress bars on our platform might
differ a bit."* Narrowed the same day: **"this can be for sold only."**

Status: **PLAN — nothing built, nothing written to Salesforce.**

> **This is not a new feature.** `docs/SALESFORCE_WRITEBACK_QUESTIONS_FOR_KATIE.md`
> (2026-09-22) already scoped it and carries **Katie's answers**. That document is
> the client-facing contract — record types, ownership, close-date policy. **This
> document is the technical design only.** Read that one first; do not re-ask what
> she has already answered.
>
> Settled there: close date **set on create, never updated** (Q1); **Tomco record
> types** — Account `012Kf000000L8Q5IAK`, Opportunity `012Kf000000L8Q6IAK` (Q6);
> **Brendan owns** the records via `OwnerId`, while the connection stays on a
> full-visibility user (Q3/§B); scope is **"only the sale"** (Q16) and **"won or
> beyond"** (Q11) — which is the same 94 deals measured below.
>
> **Still blocking, both Katie's:**
> - **Q5 — what automation fires on Closed Won.** Marked *"blocks the first real
>   write."* §3a below now ANSWERS it from PPP's own business-rules reference, and
>   the answer is the single biggest finding in this file.
> - **Q2 — duplicate prevention on CREATE** (`CCC_Id__c` external ID, or accept a
>   narrow re-create window). This is exactly what future sold jobs need — see §6.

---

## 0a. WHY — Katie, 2026-10-13, and it narrows the build

Karan asked whether Salesforce stays alive during the transition. Katie:

*"Yes, so we can see their sales in SF alongside all of the other sales from PPP.
To get a total sales picture. Eventually when we move PPP over, we will do the full
company reporting in the command center."*

**The purpose is REPORTING, and it is temporary.** Not an operational mirror — a
sales total. Three consequences, all of which make this smaller and safer:

1. **We write the sale, not the state.** No work-order status, no progress bars, no
   delivery stage. Every dangerous ambiguity in §3 lives on `WorkOrder.Status`,
   which a sales report never reads — so we do not write it, and that entire class
   of risk is designed out rather than guarded against.
2. **The money field IS the feature.** A sale that lands in Salesforce at the wrong
   value defeats the only reason Katie asked for this. See §0b.
3. **It has an end date.** When PPP moves onto Command Center, this is deleted. It
   should be built to be removed — one module, one flag, no tendrils.

## 0b. 🔴 The field that decides whether this works at all

On **every** Tomco won opportunity, `Amount` is hardcoded **$500** — regardless of
job size ($3,920, $75,000, $23,235.70 all carry Amount = 500). The real contract
value lives in **`QuotedSubtotalWithChangeOrder__c`**, which is the canonical PPP
sales metric every report reads (`AGENTS.md`) — and it is **NULL on every open
Tomco opportunity**; open deals carry the figure in `Quote_Subtotal__c` only.

So a write-back that sets `Closed Won` without also setting
`QuotedSubtotalWithChangeOrder__c` books the sale at **$500 or blank**, and Katie's
total sales picture is wrong in precisely the way she asked us to fix.

Source for the value: `commercial_projects.contract_base_cents`, set once at award
from the accepted proposal — **never** an invoice column, which has been through
the lossy `planInvoiceColumns` (§3).

## 0. The one-paragraph version

When a commercial deal is **won**, write the sale onto the matching Salesforce
Opportunity — **four fields, one object, one transition:**

| Field | Value | Why |
|---|---|---|
| `StageName` | `'Closed Won'` | the only `IsWon` stage in the org, and the one all 93 Tomco won deals already use |
| `QuotedSubtotalWithChangeOrder__c` | `commercial_projects.contract_base_cents` | **the point of the feature** — §0b |
| `CloseDate` | the award date | legal **only in the same update** that sets the stage — §3b |
| `OwnerId` | Brendan `005Kf0000021SPzIAM` | Katie's Q3 answer; also drives `Corporate_Name__c` via a flow |

Deliberately nothing else — because the org it writes into is also PPP's production
org, because the mapping this reverses is lossy in ways that make a general sync
unsafe (§3), and because Katie asked for a sales total, not a mirror (§0a).

## 3b. Two hard constraints from the org itself

**`Closed Won` is a one-way door.** The active rule `OnlyLostAfterClosedWon` permits
exactly one exit from Closed Won: `Opportunity Lost`. Unlike most rules in this org
it carries **no `Admin_Bypass` escape**, so it binds us too. A wrong write cannot be
reverted to its previous stage by anyone, including an admin. This is the single
strongest argument for a human-approval gate on the first batch.

**`CloseDate` is writable only in the same breath as the stage.**
`Close_Date_Uneditable_after_Closed_Won_L` fires on `ISCHANGED(CloseDate) AND
NOT(ISCHANGED(StageName))` — so setting both together is legal, and correcting the
date afterwards is not. Katie's Q1 answer ("set on create, never update") is
therefore not a compromise; it is the only shape the org allows.

**And a third, about who we connect as.** The integration currently authenticates as
Karan's own user (`malhotrak038@gmail.com`, Profile `Read Only` + 14 permission
sets), which holds the **`Admin_Bypass`** custom permission. Five of the org's ten
validation rules skip for it. Anything tested through this connection passes
guardrails a real Tomco user hits — so testing here proves less than it appears to,
and swapping to a proper integration user later will start failing writes that
passed today. Decide the identity before building, and test as the identity that
will ship.

---

## 1. What "sold" means

Commercial deals carry `status` + `sub_status` (`commercial_opportunities`).

**Sold = `status='pre_sale_closed'` AND `sub_status='won'`.**

Two facts about that definition shape the build:

**It is a transition, not a resting state.** A deal sold in July is now
`in_progress` or `billing`; only deals sold very recently are still sitting in
`pre_sale_closed`. Measured 2026-10-13:

| | count |
|---|---|
| sold right now (`pre_sale_closed` + `won`) | 4 |
| already past the sale (`pre_construction`, `in_progress`, `billing`, `post_sale_closed`) | 94 |
| **sold or later** | **98** |
| lost (`pre_sale_closed` + `lost`) | 1 |

So the hook fires on the *edge* into won, not on the state. A deal that races
past `pre_sale_closed` in one save must still fire.

**Salesforce cannot express it.** No `WorkOrder.Status` maps to
`pre_sale_closed/won` (`lib/commercial/import/mapping.ts:41`), and no
`Opportunity.StageName` does either (`:72`). "Sold" is a Command Center state with
no inbound equivalent — which is *why* this direction needs building at all, and
why the write target is the **Opportunity**, not the WorkOrder.

---

## 2. Where the write goes

`lib/salesforce/writeback.ts` already exists and is production-proven: retry with
backoff, an append-only `sf_writes_audit` row per attempt, cache invalidation, and
a Slack alert on rejection. Four callers use it today. **Reuse it; do not write a
second write path.**

Two gaps it has, both load-bearing here:

**`writeSf` can only UPDATE.** It builds `{ Id: recordId, ...fields }` and calls
`.update()` (`writeback.ts:152`). It cannot create. 4 of the 98 sold-or-later
deals were born in Command Center and have no Salesforce Opportunity — see §6.

**Its side effects are PPP's.** `clearSalesforceCache()` and
`alertMaterialsFailure()` are both shared infrastructure. Scoping them is §5.

---

## 3. The mapping is lossy, and inverting it naively corrupts Salesforce

`lib/commercial/import/mapping.ts` is many-to-one in at least two places:

```
Closed                 ─┐
                        ├─→ post_sale_closed / closed
Complete Paid in Full  ─┘

Coordination           ─┐
                        ├─→ pre_construction / coordination
Pending                ─┘
```

Invert that and `post_sale_closed/closed` has **two** possible Salesforce values.
Pick one and every "Complete Paid in Full" job in the org quietly becomes
"Closed" — destroying the distinction `dealStatusForWorkOrder` was written to
preserve (`mapping.ts:43-47`, whose own docblock warns that collapsing
"Complete Balance Owed" would hide $1.39M).

This is precisely Katie's "the progress bars might differ a bit," and it is not
cosmetic.

### The rule that closes it

> **Never write a status Salesforce already agrees with.**
>
> Before writing, re-read the live Salesforce value and run it FORWARD through
> the existing mapping. If the forward-mapped current value already equals the
> Commercial status, write nothing. Only write when they genuinely differ.

```
function shouldWriteStage(sfCurrentStage, commercialStatus, commercialSubStatus) {
  const asCommercial = openBidStatus(sfCurrentStage)       // forward mapping
  if (asCommercial.status === commercialStatus &&
      asCommercial.subStatus === commercialSubStatus) return null   // agree → no-op
  return TOMCO_WON_STAGE                                   // differ → write
}
```

This reuses the *existing, tested* forward mapping rather than authoring an
inverse, so the two can never drift apart. Scoping to sold-only shrinks the
problem further: we write exactly one stage value and never touch the ambiguous
WorkOrder statuses at all.

### Never write money back

`planInvoiceColumns` (`mapping.ts:405`) will **fold tax into the subtotal** when
no 3-decimal rate reproduces Salesforce's tax exactly, and `planInvoice` turns
unexplained differences into an adjustment line. Both are deliberate, both are
lossy, and both are one-directional. Writing any derived money figure back would
feed that approximation into Salesforce as fact. **Amount, tax, subtotal, and
balance are read-only in this direction, permanently.**

---

## 3a. 🔴 What `StageName = 'Closed Won'` actually does — the answer to Katie's Q5

Katie's Q5 — *"does creating an Opportunity directly in Closed Won fire any
automation we should know about before we do it 94 times?"* — has blocked the first
real write since 2026-09-22. The API cannot see flows, which is why it was asked of
her. **But PPP's own shared reference repo documents it**
(`ppp-salesforce-reference/salesforce/BUSINESS_RULES.md:126-152`), and the answer is
that this is the most expensive string in the org.

Setting an Opportunity to Closed Won fires, at minimum:

| Flow | What it does |
|---|---|
| `Opportunity_WorkOrderWhenClosedWon` | Creates **WorkOrders + WorkOrderLineItems + `Payment_Term__c` rows** from the synced Quote |
| `WorkOrder_SendLetsGetStartedEmail` | **Emails the GC's primary contact** (`:78-85`) |
| `Opportunity_Quota_Points_Record_Creation` | Creates **rep quota points, $1 = 1 point** — and re-fires whenever `TotalAmount__c` changes while won |
| `Opportunity_SetAccountTypeOnClosedWon` | Mutates **`Account.Type`** |
| `Opportunity_SetCloseDateOnClosedWon` | Stamps `CloseDate = TODAY()` (plus a redundant Apex twin) |
| `Opportunity_AdCostDetailUpdate` | Ad-cost attribution |

Three consequences that change the design:

1. **It emails Tomco's customers.** A deal marked sold in Command Center would send
   a "Let's Get Started" email to the general contractor. That is an outbound
   customer communication triggered by an internal status change, and nobody has
   agreed to it.
2. **It writes into PPP's rep compensation.** Quota points are the $1=1 point rows
   behind rep scorecards. Tomco sales would land in PPP reps' quota attainment.
3. **It is not reversible by symmetry.** `Opportunity_DeleteQuotaPoints` tears the
   points down on un-win, so a mistaken write is not undone by writing the old value
   back.

**Therefore `Closed Won` must not be written automatically.** The sold write-back
needs a human-approval gate at the top, not a mapping table at the bottom — and
Katie and Brendan need to agree to the email before the first one goes out.

This also retires the "immediately" in Katie's original request, at least for the
stage write: immediate and unattended are different things, and this one cannot be
unattended until the email question is settled.

---

## 4. Scoping to Tomco — the only real boundary

PPP and Tomco share **one Salesforce org and one set of credentials**. There is no
account separation and no second connection to hide behind. "Don't mix it with
PPP" is enforced entirely by one field:

```
Corporate_Name__c = 'Tomco Painting'
```

**Therefore: verify before every write.** The write-back must re-read the target
Opportunity and confirm `Corporate_Name__c === 'Tomco Painting'` *in the same
code path that writes*, refusing otherwise. Not a filter on the way in — a guard
at the moment of writing. A commercial deal whose `commercial_import_map.sf_id`
points at a non-Tomco record is a bug that must fail loudly, not write quietly.

This guard is cheap (the read is needed anyway for §3) and it is the single
control standing between this feature and PPP's production data.

---

## 5. Shared infrastructure that must be scoped

`writeSf` does four things beyond the `update()` call, and three of them are
**global, not per-record**. Each needs scoping before a single Tomco write runs.

### 5a. 🔴 `clearSalesforceCache()` would cold-start PPP on every Tomco write

`writeback.ts:173` fires it on every success. It is not selective
(`lib/salesforce/queries.ts:191-209`): `cache.clear()` wipes the whole in-memory
map, four describe caches are nulled, three rows are **DELETED** from
`snapshot_cache` (so serve-stale cannot rescue anyone), and `bumpGeneration()`
invalidates every other Vercel instance.

The next PPP reader then pays a full live rebuild — 8-15s by the file's own
comment (`queries.ts:28`), ~90+ SOQL calls across 89k Opportunities and 88k
WorkOrders (`:358`, `:1207`). The warm cron is `0 6 * * *` only, so there is no
backstop until morning. A Tomco deal marked sold at 7:55am means **Alex's 8:00am
phone load is the cold path**.

Fix: add an explicit `skipCacheInvalidation` / `platform: "commercial_cc"` flag to
`writeSf`'s ctx and gate `:173` on it. **Also gate `writeSfBatch:281`** — it is a
separate call that would look fixed and not be.

### 5b. 🔴 A Tomco failure would page PPP's residential materials Slack

`writeback.ts:224` calls `alertMaterialsFailure()` unconditionally — no source
check — posting to `PPP_MATERIALS_SLACK_WEBHOOK` with `[PPP alert]` subject copy
about the residential colors hub. Kate's channel, wrong platform, and the Tomco
people who could act on it never hear.

The irony is on the record: `lib/alerts/materials-alerts.ts:14-16` says routing
residential failures into the commercial channel "would cross two engagements that
are kept apart on purpose." This is that crossing, reversed.

Fix: branch on `ctx.source`. Tomco failures go to
`reportError({ platform: "commercial_cc", … })` →
`COMMERCIAL_INCIDENT_SLACK_WEBHOOK` (`lib/observability.ts:202`), which already
has 5-minute dedup and never throws.

### 5c. 🟠 Shared org, shared token, shared API budget

One login serves both. There is **no `REQUEST_LIMIT_EXCEEDED` handling anywhere in
`lib/salesforce/`** — a Tomco batch burning the org's daily API budget would
silently break PPP's snapshot rebuilds with nothing identifying the cause.

Fix: a `TOMCO_SF_WRITEBACK=on` kill switch modeled on `PAYMENTS_SF_WRITEBACK`
(`lib/payments/config.ts:137`), so writes can be stopped with one Vercel env change
and no deploy. Sold-only keeps the volume to a handful of writes a week, which
makes this a guard rather than a throttle.

### 5d. 🟠 The import boundary — and the module this code belongs in

`lib/commercial/README.md:6-17` **bans** `lib/commercial/*` from importing
`lib/salesforce/*`: "Do not back-door across the boundary." Nothing enforces it —
no eslint rule, no gate step, no test.

Worse, `scripts/check-sf-fields.mjs:24` reads **only** `lib/salesforce`. SOQL placed
under `lib/commercial/` is invisible to the field checker, silently voiding the
protection from `feedback_a_soql_fallback_hides_the_bug`.

Decision: the Tomco write-back lives at **`lib/salesforce/tomco.ts`**, mirroring how
`lib/salesforce/payments.ts` sits there while serving `lib/payments/`. The commercial
side calls it from an `app/api/commercial/…` route rather than importing it into
`lib/commercial/`. Then add the missing enforcement as
`scripts/check-platform-boundary.mjs` — and prove it can fail before trusting it.

### 5e. 🟡 `sf_writes_audit` leaks into a PPP admin screen

`/api/admin/health:468` is correctly filtered. But
`app/api/admin/writeback-diagnose/route.ts:403-404` does an unfiltered
`select("*").limit(20)` plus an exact count, so Tomco rows would crowd a page whose
whole purpose is "is the customer form's writeback working?"

Fix: give Tomco its own `SfWriteSource` literal — **never** reuse `admin_manual` or
`system_resync`, which existing readers already filter on — and exclude it there.

---

## 5f. A pre-existing finding this work uncovered (not caused by it)

**PPP's dashboard may already be counting Tomco's jobs.** Every snapshot query in
`lib/salesforce/queries.ts` filters on dates and status only — `Opportunity … WHERE
CreatedDate = LAST_N_DAYS:365` (`:1221`), `WorkOrder …` (`:2045`). `Corporate_Name__c`
appears **nowhere** in `lib/` or `app/`; its only occurrence in executable code is
`scripts/import-tomco.mjs:60`.

If Tomco Opportunities and WorkOrders live in the same objects inside the 365-day
window, they are already inflating PPP's KPIs, leaderboard and rep scorecards —
today, with no write-back built. **Unverified**; the counts are being measured.

This matters twice over: it is a correctness bug for Alex's dashboard in its own
right, and it decides whether §5a's fix is strictly correct or a trade-off.

---

## 6. Deals with no Salesforce counterpart

4 sold-or-later deals have no `commercial_import_map` row and so no Opportunity
to update:

- Cummins-Interior *(pre_sale_closed)*
- PCCI Builders Corp. Eastport Facade Renovation *(pre_sale_closed)*
- Flagstar Bank Trash Enclosures *(pre_sale_closed)*
- Thermo Fisher Inspection Room & Exterior Door *(pre_construction)*

`writeSf` cannot create. Three options, in increasing risk:

1. **Skip and report.** The write-back no-ops and surfaces them on a screen Katie
   can see. Nothing is invented in Salesforce. *(recommended for v1)*
2. **Create on demand.** Needs `Account`, `Corporate_Name__c`, `StageName`,
   `CloseDate` and whatever else is required-on-create — and creating records in a
   shared production org is the highest-risk operation in this document.
3. **Katie creates them by hand**, then they link like the other 94.

Deciding this is Katie's call, not mine. v1 should ship option 1 and show her the
list.

---

## 6a. 🔴 BLAST RADIUS — measured 2026-10-13, and it inverts the premise

Measured live against production (`precisionplus.my.salesforce.com` — note the stored
refresh token is **production, not the sandbox**), reading `OpportunityFieldHistory`
and `WorkOrderHistory` rather than trusting `LastModifiedDate` alone.

Of the 94 linked sold-or-later deals: **83 AGREE** (write-back is a no-op) and
**11 DISAGREE**.

**The premise was that Command Center is ahead and Salesforce is stale. It is the
other way round on 8 of the 11.**

### Mary is still running Tomco's back office in Salesforce — today

28 of 94 linked deals have been modified since go-live. Not rollup artifacts — named,
deliberate edits in the field history:

- **9 WorkOrder status changes made by hand**, all by Mary O'Sullivan, between
  2026-09-22 and 2026-10-06
- **176 `Transaction__c` rows created** since 2026-09-17 (76 Purchase, 82 Payment_Out,
  18 Payment_In) — receipts still flowing daily
- **6 Tomco Opportunities born in Salesforce** after the migration, with no Command
  Center row
- Most recent edit: **2026-10-13, the day of this measurement**

**Every one of those 9 hand-edited work orders appears in the disagreement list.** The
disagreements are not drift. They are Mary working the jobs.

### What the write-back would actually do

| Deal | Salesforce today | Write-back sets | Damage |
|---|---|---|---|
| DuCon- TENANT 4 Henry Street | **Complete Paid in Full** (Mary, 10-06) | → Complete Balance Owed | $12,600 paid job reopened as owing |
| North Shore Dental | **Complete Paid in Full** (Mary, 10-06) | → Complete Balance Owed | $3,920 paid job reopened as owing |
| AIREF Building #4- Bellport | Coordination | → Work In Progress | $256,624.50 contract |

Two fully-paid jobs pushed back to "balance owed," directly reversing work Mary did on
2026-10-06. That is not a sync; it is a regression with a GC-visible AR consequence.

Three more (`post_sale_closed/closed` at `Complete Paid in Full`) are writes **only if**
we resolve the `Closed` vs `Complete Paid in Full` ambiguity the wrong way — §3's guard
turns those 3 writes into 0 on its own.

### Insert would duplicate live Salesforce records

**Two of the four unlinked deals already exist in Salesforce**, created by Mary and
sitting at `Estimate Sent`:

- "PCCI Builders Corp. Eastport Facade Renovation" ($8,900) ↔ SF `006Wj00000nNN1JIAW`
  "Facade Renovation-Eastport" (quote **$9,350** — the two disagree by $450)
- "Cummins-Interior" ($5,150) ↔ SF `006Wj00000qbgLhIAI` "Cummins -Interior" (exact
  money match, created the same day as the Command Center row)

So the create path §6 called the main event would, run today, **duplicate two live
opportunities** — which is precisely the failure Katie's Q2 (`CCC_Id__c`) exists to
prevent, now with named records attached.

### Two more traps found in passing

- **3 deals have a second, Canceled WorkOrder.** A write-back selecting by
  `Opportunity__c` without excluding `Status='Canceled'` could reopen a canceled record.
- **`Opportunity.Amount` is $500 on essentially every won Tomco deal.** It is not a
  usable money field; the contract lives on the WorkOrder. (Matches Q7's default.)

### ✅ The one clean result

All 132 `commercial_import_map` deal rows resolve to live Opportunities, and **all 132
carry `Corporate_Name__c='Tomco Painting'`**. Zero PPP records reachable through the
map. The §4 boundary holds — the guard is still required, but it is currently guarding
a clean set.

### What this forces

1. **A `LastModifiedDate` gate is mandatory, not a nicety.** Refuse to write any record
   whose Salesforce side moved after Command Center's `updated_at`; report it instead.
   That converts the dangerous 8 into a review queue. The importer already has this
   pattern (`WROTE_AT` / `SF_WINS`) — mirror it.
2. **Do not let v1 insert.** Two of four would duplicate.
3. **The dual run is not winding down.** A write-back shipped now is not refreshing a
   stale mirror; it is contending with a live user who is doing her job correctly.

---

## 7. Open questions for Katie

1. Which Salesforce stage means "we won it" for Tomco? *(pending schema probe)*
2. The 4 unlinked deals — skip, auto-create, or hand-create?
3. Should a deal moving *out* of won (sold then cancelled) write anything back?
   v1 says no: one-way, won-only, never un-win a Salesforce record.
4. Salesforce was supposed to be retired ~2026-10-01. It is still live and being
   written to. How long does the dual run continue? That answers whether this is a
   bridge or a permanent integration.
