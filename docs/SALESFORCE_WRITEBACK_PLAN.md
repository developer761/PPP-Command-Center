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

## 1. The question that decides everything

**Salesforce is currently scheduled to be switched off for Tomco around 2026-10-01** —
about nine days away. That is why the delta sync is being run by hand every night, and
the standing instruction on this project has been *"we don't have to write anything back
to Salesforce, we're gonna get rid of it soon."*

Katie's request is the opposite. Both can be true, but only one of these is the actual
situation, and they lead to very different amounts of work:

| If… | Then |
|---|---|
| **A. Salesforce stays** as PPP corporate's system of record, and Tomco simply stops working in it day-to-day | Write-back is **permanent infrastructure**. Build it properly: ongoing, monitored, reconciled. This is the most likely reading — Tomco is the acquisition, PPP's Salesforce is where corporate reporting lives. |
| **B. Salesforce is genuinely being retired** in ~9 days | Don't build a sync. Do **one final export** of CCC-native sales into Salesforce and stop. Weeks of integration work for a system with days left is money lit on fire. |
| **C. Salesforce is retired for operations but kept read-only for history** | Same as B — a one-time backfill, not a sync. |

**Nothing below should start until this is answered.** Everything else in this document
is the same either way; only whether it runs *once* or *forever* changes.

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

These are the real record shapes, read out of Tomco's own Salesforce rather than assumed.

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

**② Validation rules are invisible to the schema check.**
Salesforce says only three fields are required on Opportunity, but validation rules and
required-on-layout fields do not show up that way. Phase 3 exists precisely to find these
the cheap way — on one record, not 132.

**③ "An account if it doesn't already exist" is the hardest sentence in the request.**
Matching on company name is fragile: *Above All Services* vs *Above All Services Inc.*
creates a duplicate GC in Salesforce, and a duplicate customer is much worse than a
missing one. 75 of our 76 accounts already carry a Salesforce id, so they are exact
matches. For genuinely new accounts I'd propose: exact name match → use it; near match →
**stop and ask a human**, never guess.

**④ Two-way editing needs a rule, and doesn't have one.**
Today the sync is one-way and the platform wins: an edit made in Command Center is never
overwritten by Salesforce (the guard reported one such row again tonight). Write-back
introduces the opposite collision — a deal edited in *both* systems since the last run.
**Someone has to decide who wins.** My recommendation: Command Center wins for deals it
owns, because that is where the work now happens, and anything else gets reported rather
than silently resolved.

**⑤ Closed Won is not reversible in the same way on both sides.**
A deal un-won in Command Center would need its Salesforce opportunity moved *out* of
Closed Won, which may trip org automation. Worth deciding whether write-back handles
un-winning at all, or refuses and flags it.

**⑥ Record ownership.** Every record created by an integration needs an `OwnerId`. If
everything lands on one service user, Tomco's rep-level reporting will be wrong.

---

## 7. What we need from Katie / Tomco

1. **Is Salesforce staying?** (§1 — blocks everything.)
2. **Can our integration user write the Tomco Work Order record type?** (§6①)
3. **What should `Amount` hold** on the Opportunity, given the contract value belongs in
   `QuotedSubtotalWithChangeOrder__c`? (§3.2)
4. **What `Status` should a new Work Order start in?**
5. **Who owns records the sync creates** — one service user, or the Tomco rep? (§6⑥)
6. **When Command Center and Salesforce disagree, which wins?** (§6④)

---

## 8. Honest estimate

Assuming answer **A** (Salesforce stays):

- Phases 1–3 — writer, dry run, one real deal: **the bulk of the work**, and where the
  unknowns live.
- Phase 4 — the 132 back-updates: small *if* ④ is settled, open-ended if not.
- Phase 5 — nightly + reconcile coverage: small, and the part that keeps it honest.

Assuming **B or C**, this collapses to a one-time export and is a fraction of the work.

The single largest risk is not technical. It is building a permanent two-way integration
for a system that may be switched off in nine days.
