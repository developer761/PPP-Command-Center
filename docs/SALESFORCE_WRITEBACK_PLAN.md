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

## 3. What gets written, concretely

These are the real record shapes, read live out of PPP's production org rather than
assumed — taken from an existing Tomco work order and its parents.

> The record-type rows below assume the **first** reading in §1.2 (keep Tomco's
> identity). If Katie wants standard PPP record types instead, swap the two ids; nothing
> else in this section changes.

### 3.1 Account — only if it doesn't already exist

| Salesforce field | Value |
|---|---|
| `Name` | `commercial_accounts.company_name` |
| `RecordTypeId` | `012Kf000000L8Q5IAK` — the **Tomco** account record type |
| `Type` | `Customer` |
| `BillingCity` / `BillingState` | `billing_city` / `billing_state` |
| `OwnerId` | **open question — see §7** |

No fields are strictly required by the schema, but see the validation-rule risk in §6.

### 3.2 Opportunity — Closed Won

Required on create, per Salesforce: **`Name`, `StageName`, `CloseDate`.** That's all three.

| Salesforce field | Value |
|---|---|
| `Name` | the deal's title |
| `AccountId` | the account from 3.1 |
| `StageName` | `Closed Won` *(confirmed a valid picklist value)* |
| `CloseDate` | **`commercial_opportunities.decided_at`** — the date the deal was decided. This is the CCC "close date" Katie means. |
| `RecordTypeId` | `012Kf000000L8Q6IAK` — the **Tomco** opportunity record type |
| `QuotedSubtotalWithChangeOrder__c` | `accepted_contract_cents ÷ 100` |
| `Amount` | see the warning below |

> ⚠️ **`Amount` is not the contract value in this org.** On the sample deal I read,
> `Amount` was **$500** while `QuotedSubtotalWithChangeOrder__c` was **$21,328.40**.
> `QuotedSubtotalWithChangeOrder__c` is the canonical sales metric — every PPP report is
> built on it. If we write the contract into `Amount`, Tomco's numbers will look right on
> the record and wrong in every report. **Katie needs to confirm what `Amount` should
> hold**, or we leave it alone.

### 3.3 Work Order — Interior Painting

| Salesforce field | Value |
|---|---|
| `AccountId` | as above |
| `Opportunity__c` | the opportunity from 3.2 — this is the link field |
| `WorkTypeId` | `08q6g000000dTxNAAU` — **Interior Painting** *(confirmed to exist)* |
| `Status` | open question — real Tomco records use values like `Work In Progress`, `Complete Balance Owed` |
| `Quoted_Subtotal_with_Change_Order__c` | same contract value *(note: the Work Order field name uses underscores, the Opportunity one does not — a long-standing trap in this org)* |
| `RecordTypeId` | ⚠️ **blocked — see §6** |

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
