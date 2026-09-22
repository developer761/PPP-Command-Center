# Syncing Command Center sales back into Salesforce

**Asked by Katie, 2026-09-21.** Plan only — nothing is being built yet.

> "Can we update the Command Center so that the sales entered there sync back over to
> Salesforce? It will need to create 1. An account if it doesn't already exist, 2. An
> Opportunity (in Closed Won stage), 3. A Work Order with Work Type: Interior Painting.
> The Close Date should be synced to the Close date in the CCC."
>
> And on Karan's question of new-only vs. already-migrated: *"We should probably make
> updates between the ones that were moved over already."*

---

## 1. Settled: the target is PPP's org, and it is production

**Karan, 2026-09-22: "we want to write back to PPP salesforce not Tomcos, and don't worry
about when we get rid of salesforce for Tomco."**

Worth stating plainly, because it is easy to picture this wrong: **there is only one
Salesforce org.** "Tomco's Salesforce" is not a separate system — it is Tomco's records
living inside PPP's org, told apart by *record type*.

| | |
|---|---|
| Org | **Precision+** (`00D6g000001XvD9EAK`) at `precisionplus.my.salesforce.com` |
| Sandbox? | **No — this is production** |
| Accounts | 92,559 |
| Opportunities | 95,434 — of which **188** carry the Tomco record type |
| Work Orders | 95,896 |
| Connected as | `malhotrak038@gmail.com` |

So the earlier worry — "don't build a permanent integration for a system being switched
off in nine days" — **does not apply.** Tomco stopping work in Salesforce does not retire
the org; PPP's org is the corporate system of record and it stays. This is permanent
infrastructure, and the phases below are the long-lived version.

Two consequences fall straight out of that, and both are new:

### 1.1 ⚠️ We would be writing into a live org with ~95,000 opportunities

Every earlier assumption about blast radius was too generous. This is not a Tomco
sandbox with 132 deals in it; it is PPP's production Salesforce, and a bad create loop
writes junk into the org the whole company reports on.

Non-negotiables that follow:

- **Default to dry-run, always.** Writing requires an explicit flag, every time.
- **Cap every run.** A first pass refuses to write more than N records without
  `--yes-really`. A runaway loop against 95k records is the worst outcome available here.
- **Test in the sandbox first if one exists.** A `dev` sandbox has been referenced on this
  project before; if it is still usable, Phase 3 belongs there, not in production.
- **Every write is logged with its Salesforce id**, so anything wrong can be found and
  undone. An untraceable write into a 95k-record org is effectively permanent.

### 1.2 ⚠️ The record-type question is now the central mapping decision

There are two plausible readings of "write to PPP's Salesforce, not Tomco's", and they
produce different records:

| Reading | Account RT | Opportunity RT | Effect |
|---|---|---|---|
| **Keep Tomco's identity** — new sales look like the 188 already there | Tomco `012Kf000000L8Q5IAK` | Tomco `012Kf000000L8Q6IAK` | Consistent with existing Tomco data; keeps Tomco separable in reporting |
| **Land as standard PPP records** | Customer `0126g000000Oic8AAC` | New `0126g0000004CX5AAM` | Tomco sales blend into PPP's main pipeline; no longer separable by record type |

**This needs Katie, and it is not reversible cheaply** — record type drives page layouts,
picklists, validation rules, automation and reporting. My read is that the *first* is
what's wanted (Tomco sales staying identifiable inside PPP's org, which is what the
record types exist for), but I am not guessing on something this structural.

---

## 2. Where things actually stand today

Measured against live data, 2026-09-22:

| | Count |
|---|---|
| Opportunities in Command Center | **132** |
| …that came **from** Salesforce | **132** |
| …**created in** Command Center | **0** |
| Accounts | 76 (75 from Salesforce, 1 created here) |
| Won / in-delivery opportunities | 94 — all 94 have a decided date, 90 have a contract value |
| Total accepted contract value | **$2,676,983.67** — ties to Salesforce to the cent |

**Nobody has entered a new sale in Command Center yet.** Every deal on the platform came
out of Salesforce during the migration.

That matters for two reasons:

1. The "sync new sales back" half currently has **zero records to sync**. It is worth
   building for what comes next, not for a backlog.
2. The "update the ones already moved over" half — Katie's follow-up — is the part with
   real volume behind it: **132 deals that already carry a Salesforce id**.

So the work splits cleanly, and the second half is the one with something in it today.

---

## 3. What gets written — through a QUOTE, not three records by hand

**Changed 2026-09-22.** Katie: *"Would it make more sense to sync the proposal from
Commercial Command Center to the Quote and then move that to Approved & Sync and allow
Salesforce to trigger its automations rather than perform the creation on its own?"*

Yes, and it is the better design. The reasoning is in
[`ppp-salesforce-reference/salesforce/BUSINESS_RULES.md` → "The Closed Won cascade"],
pushed by Katie as `c07be4b`.

Creating the Opportunity and Work Order ourselves means **re-implementing PPP's own rules
in a second place**, where they will drift the moment Salesforce changes. Driving a Quote
to Approved makes Salesforce build everything downstream using the rules it already has,
so a Tomco sale comes out shaped like every other PPP sale rather than a sparse variant.

### The sequence

1. **Account** — create only if new (Tomco record type `012Kf000000L8Q5IAK`).
2. **Opportunity** — created **NOT won**. `Opportunity_SetStageWhenQuoteSync` requires
   "not-yet-won + `SyncedQuoteId` populated + synced quote `Approved`/`Accepted`", so
   creating it already-won would skip the very cascade we want.
3. **Quote + line item**, on the opportunity's pricebook.
4. **Quote → `Approved`.**
5. **THEN sync it** — set `Opportunity.SyncedQuoteId`. Everything below happens on its own.

> ### ⚠️ Approve BEFORE syncing. This order is not interchangeable.
>
> **Katie, 2026-09-22: "Quote created with quote line item, Status = Approved, then Sync.
> Sync can't come before Approved or it won't work."** I had it the other way round.
>
> The reason is worth understanding, because nothing errors when you get it wrong — it
> just silently does nothing. `Opportunity_SetStageWhenQuoteSync` is a record-triggered
> flow **on the Opportunity**, and its entry criteria are *not-yet-won + `SyncedQuoteId`
> populated + the synced quote `Approved`/`Accepted`*.
>
> Setting `SyncedQuoteId` **is** the Opportunity save that evaluates those criteria. So:
>
> - **Sync first, approve after** → at the moment of the Opp save the quote is still
>   `Draft`, the criteria are false, and the flow does not fire. Approving the quote
>   afterwards does not save the Opportunity, so nothing re-evaluates it. The deal sits in
>   an open stage with an approved quote attached and **no cascade at all** — no Closed
>   Won, no Work Order, no quota points.
> - **Approve first, sync after** → the quote is already `Approved` when the Opportunity
>   saves, the criteria are true, and the whole cascade runs.
>
> The failure mode is a deal that looks half-finished in Salesforce with nothing to
> explain it, so the sync should **verify the stage actually moved** after syncing rather
> than assume it did.

### What Salesforce then does for us

| Fires | Result |
|---|---|
| `Quote_SetOpportunityStageClosedWonOnApproved` / `Opportunity_SetStageWhenQuoteSync` | Opp → **Closed Won**, `TotalAmount__c` ← quote `GrandTotal__c`, `CloseDate` = today |
| `Opportunity_WorkOrderWhenClosedWon` | **the Work Order**, its line items, and `Payment_Term__c` rows — with `Corporate_Name__c`, `CostMaterials__c`, `MaterialType__c`, `Materials_Included__c` mapped properly |
| `Opportunity_SetAccountTypeOnClosedWon` | Account.Type → Customer / Repeat Customer |
| `Opportunity_Quota_Points_Record_Creation` | QuotaPoints at $1 = 1 point |
| `WorkOrder_SetOpportunityFinancialFields` | the money written back up to the Opp |

### Two consequences that change what we write

**① We must NOT set the money on the Opportunity.** `WorkOrder_SetOpportunityFinancialFields`
copies `TotalAmount__c` and `QuotedSubtotalWithChangeOrder__c` **up from the Work Order**,
last-writer-wins, not a sum. Anything we write on the Opportunity is overwritten the
moment the Work Order saves. **The contract value belongs on the Quote's `GrandTotal__c`**
and flows down to the WO and back up. Writing it on the Opportunity directly would look
correct for a second and then be replaced.

**② Close Date resolves itself.** Katie, 2026-09-22: *"Close Date should always reflect
the date of the sale aka moving to Won."* Because we push at the moment a deal is won in
CCC, `CloseDate = TODAY()` **is** the sale date, so the automation is already correct and
we set nothing. The one gap: if the push fails and the nightly sweep retries a day later,
the close date is a day late and the validation rule forbids correcting it. Those must be
**flagged for manual correction**, not silently accepted.

### What makes this easy — and it was the thing I expected to be hard

Tomco quotes do not itemise. A real one (`0Q0Wj000006WmKbKAK`) carries **one** line: the
generic product **"Other"**, qty 1, unit $500, with the real $21,328.40 in `GrandTotal__c`.
That is why every Tomco opportunity shows `Amount = 500`. **So there is no product
mapping to do** — we reproduce the shape Tomco already uses.

### Still to confirm in the sandbox

- Is `GrandTotal__c` **writable**, or derived? The whole design hinges on getting the
  contract value in there.
- Which **stage** to create the opportunity in before the quote approves.
- Does the quote need to pass through **`Quote Sent`** first, or can it go straight to
  `Approved`? (Values: Draft | Quote Sent | Approved | Rejected.)
- Should Tomco sales generate **quota points** at all? They will, automatically, and
  re-fire whenever `TotalAmount__c` changes.

### Risks this removes outright

The Work Order record type our user appeared not to have, the Work Order status to start
in, whether Work Type is always Interior Painting, and the fields we would have missed —
**all gone.** Salesforce creates the Work Order, so Salesforce decides all of it.

---

## 4. How it stays correct: one id map, reused

The platform already has `commercial_import_map` (`entity`, `sf_id`, `row_id`) — 5,364
rows recording what came from Salesforce. **Write-back uses the same table in the other
direction.** A record created in Salesforce by the sync immediately gets a row there.

That single decision gives us, for free:

- **Idempotency.** Re-running never double-creates: if a CCC deal already has a `deal`
  row in the map, it is an *update*, not an *insert*. Run it as often as you like.
- **The new-vs-migrated split Katie asked about**, with no extra bookkeeping. Present in
  the map → update. Absent → create.
- **A reconcile that already works.** `--reconcile` compares the two systems today; it
  will cover write-back the moment write-back uses the same map.

---

## 4b. It should NOT be a nightly manual run — push on the event, sweep nightly

Karan, 2026-09-22: *"why can't we just autosync from Commercial Command Center to
Salesforce instead of a nightly manual run?"* — right, and it should.

**The nightly-by-hand habit belongs to the other direction.** Salesforce → CCC is manual
because it has to *poll* an external system for changes nobody told us about, and Karan
chose not to automate that for a two-week dual run. Write-back is the opposite situation:
**we own the event.** The platform knows the exact moment a deal is won, because the deal
is won *here*. Nothing to poll.

Every piece needed already exists:

| Need | What we already have |
|---|---|
| The moment a deal is won | `changeOpportunityStatus()` — one choke point every win passes through |
| Push without making the user wait | `afterResponse()` — runs past the response and survives Vercel freezing the instance |
| A nightly safety net | the `commercial-daily` cron, already running (heartbeat fired 12:00 UTC today) |

### The design

1. **On win** — `afterResponse()` pushes to Salesforce. The user's click returns
   immediately; the sync happens behind it. If Salesforce is slow or down, nobody is
   blocked and nothing is lost, because of step 2.
2. **Nightly** — the existing cron sweeps for anything **not yet confirmed in Salesforce**
   and retries it.

The push is what makes it feel instant. **The sweep is what makes it reliable**, and it is
not optional — the push can fail for reasons that have nothing to do with us:

- Salesforce down, or API limits hit
- A validation rule rejects the record (there are twelve, and we cannot see the flows)
- The deploy rolled mid-push
- A won deal is edited days later
- The 132 existing deals need back-filling once, on a schedule nobody clicks

### …and the sweep is also the answer to the duplicate problem (§6③)

This is the part worth noticing: **one mechanism solves both.** The workaround for staying
on Salesforce's own Ids instead of adding `CCC_Id__c` is simply **never create blind**:

1. **Record the intent first**, in our own database — *"about to create account X"* — before
   calling Salesforce at all.
2. **Search before creating.** Look for a matching record (name + Tomco record type +
   created recently). If one is there, **adopt it** — store its Id — rather than making a
   second.
3. **Create** only when the search comes back empty.
4. **Store the returned Id immediately.**
5. **The nightly sweep finishes the job**: any intent row still carrying no Salesforce Id
   gets searched again — and either adopts the orphan that step 1's crash left behind, or
   retries the create.

The lost-response window that worried us closes at step 2, because a re-run *looks* before
it writes. It costs one extra query per created record, which at 94 records is nothing.

`CCC_Id__c` would still be better — it makes duplicates *structurally* impossible rather
than *very unlikely*, with no search and no intent table. But this is a real workaround,
and it needs nothing from Katie.

---

## 5. The steps

**Phase 0 — decide (blocks everything).** Answer §1. Confirm `Amount`, Work Order
`Status`, and record ownership (§7).

**Phase 1 — a writer that cannot fire by accident.** A new module, separate from
`import-tomco.mjs`. That importer has a hard read-only guard — a Proxy that *throws* on
any create/update/delete — and **that guard stays exactly as it is.** The migration
importer being provably incapable of writing to Salesforce is worth keeping; the writer
is its own path, with its own switch, defaulting to dry-run.

**Phase 2 — dry run, on real data, writing nothing.** Print every record it *would*
create or update, with the resolved account match, for all 132 deals. Katie and Brendan
read the list. This is where duplicate-account problems surface, and they will (§6).

**Phase 3 — one deal, end to end.** Write a single new deal into Salesforce. Check it in
the Salesforce UI: right record types, right Work Type, right close date, contract value
in the right field, and it appears correctly in the reports Katie actually uses. Fix, and
only then continue.

**Phase 4 — the 132 already-migrated deals.** These already exist in Salesforce, so this
is an update pass, not a create pass. Needs the conflict rule from §6 settled first.

**Phase 5 — ongoing.** Fold into the nightly run. Extend `--reconcile` so a record that
failed to write back is *reported*, not silently missing — the failure mode this platform
keeps producing is a thing that quietly does nothing.

---

## 6. Risks and edge cases — the ones that will actually bite

**① The Work Order record type may be unavailable to our integration user.**
Real Tomco work orders carry `RecordTypeId 012Kf000000L8Q8IAK`, but when I asked
Salesforce which Work Order record types our connected user can use, it returned
**none**. So the integration may be unable to set it, and every work order we create
could land on the wrong record type — or the create could fail outright. **This needs
checking with Katie before Phase 3.** It is the single most likely thing to break.

**② Validation rules — now read, and one of them blocks the request.**
`Close_Date_Uneditable_after_Closed_Won_L` is ACTIVE on Opportunity: the close date
cannot be changed once a deal is Closed Won. Every one of the 132 deals we would update
is already Closed Won, so **every close-date update will be rejected** until the
integration user is exempted. `OnlyLostAfterClosedWon` constrains stage moves, and Work
Order carries seven active rules gating completion (start/end dates, assigned crew,
undeposited payments, attendance). Flows and triggers still cannot be read from the API,
so Phase 3 remains the cheap way to find whatever is left — on one record, not 132.

**③ Idempotency wants a new External ID field.** `LegacyId__c` exists as a unique
External ID on all three objects but is already in use (50,592 / 47,794 / 39,225
records), so it must not be reused. A fresh `CCC_Id__c` on Account, Opportunity and Work
Order turns the whole sync into an `upsert` — natively idempotent, no query-then-insert
race, and duplicates become impossible rather than merely unlikely. Note
`WorkOrder.Command_Center__c` already exists and is NOT this: it is a read-only formula
rendering a link back to the hub, populated on all 95,896 work orders.

**④ "An account if it doesn't already exist" is the hardest sentence in the request.**
Matching on company name is fragile: *Above All Services* vs *Above All Services Inc.*
creates a duplicate GC in Salesforce, and a duplicate customer is much worse than a
missing one. 75 of our 76 accounts already carry a Salesforce id, so they are exact
matches. For genuinely new accounts I'd propose: exact name match → use it; near match →
**stop and ask a human**, never guess.

**⑤ Two-way editing needs a rule, and doesn't have one.**
Today the sync is one-way and the platform wins: an edit made in Command Center is never
overwritten by Salesforce (the guard reported one such row again tonight). Write-back
introduces the opposite collision — a deal edited in *both* systems since the last run.
**Someone has to decide who wins.** My recommendation: Command Center wins for deals it
owns, because that is where the work now happens, and anything else gets reported rather
than silently resolved.

**⑥ Closed Won is not reversible in the same way on both sides.**
A deal un-won in Command Center would need its Salesforce opportunity moved *out* of
Closed Won, which may trip org automation. Worth deciding whether write-back handles
un-winning at all, or refuses and flags it.

**⑦ Record ownership, and whose name is on it.** The integration is currently connected
as **`malhotrak038@gmail.com`** — Karan's own login. Left alone, every account,
opportunity and work order the sync creates in PPP's production org is created and owned
by Karan, which is wrong for rep-level reporting and wrong for the audit trail. This
wants a dedicated integration user, and an explicit `OwnerId` per record.

> **The full, sendable question list is in
> [`SALESFORCE_WRITEBACK_QUESTIONS_FOR_KATIE.md`](./SALESFORCE_WRITEBACK_QUESTIONS_FOR_KATIE.md).**
> The summary below is the short form.

---

## 7. What we need from Katie / Tomco

The sendable version lives in
[`SALESFORCE_WRITEBACK_QUESTIONS_FOR_KATIE.md`](./SALESFORCE_WRITEBACK_QUESTIONS_FOR_KATIE.md).
Six blockers, in short:

1. **Close date is locked after Closed Won** — exempt the integration user, or accept
   create-only? (§6②)
2. **Add `CCC_Id__c`** (Text 36, External ID, Unique) on Account / Opportunity / Work
   Order, so the sync can upsert and duplicates become impossible. (§6③)
3. **Create an integration user** — decided 2026-09-22 that the sync runs as a separate
   email, not Karan's. Needs Create/Edit on the three objects, API enabled, and an owner
   decision for the records it creates. Plus: is there a sandbox? (§6⑦, §1.1)
4. **Confirm that user can use the Tomco Work Order record type** — Salesforce currently
   reports none available. (§6①)
5. **What automation fires on creating a Closed Won opportunity?** Invisible to the API,
   and we would be doing it up to 94 times. (§1.1)
6. **Tomco record types, or standard PPP?** (§1.2)

## 8. Honest estimate

- Phases 1–3 — writer, dry run, one real deal: **the bulk of the work**, and where the
  unknowns live.
- Phase 4 — the 132 back-updates: small *if* the conflict rule (§6⑤) is settled,
  open-ended if not.
- Phase 5 — nightly + reconcile coverage: small, and the part that keeps it honest.

The largest risk is no longer the timeline — it is the **blast radius**. We would be
writing into PPP's live Salesforce alongside ~95,000 existing opportunities. Everything
in §1.1 exists so that a mistake is small, visible and reversible, rather than 132 bad
records scattered through the org the whole company reports on.
