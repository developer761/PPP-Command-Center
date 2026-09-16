# Tomco → Commercial Command Center: migration plan

Karan, 2026-09-15. Nothing here has been run. Salesforce is **read-only** for the
whole exercise; every write lands in the Commercial platform.

Rule for this migration, from Karan: **every KPI and total lines up to the cent.**
Where Salesforce disagrees with itself (it does, in seven places), this plan says
which side wins and why.

---

## 1. Scope

**In:**

| | Count |
|---|---|
| Deals | **132** — 92 won jobs + 40 open bids |
| GC accounts | 75 |
| Contacts | 93 |
| Jobs (work orders, non-canceled) | 92 |
| Scope lines | 134 |
| Purchases | 812 |
| Labor payouts | 790 |
| Reimbursements | 25 |
| Payments in | 109 |
| Attendance rows | 1,920 (14,632.5 hours) |
| Crew workers | 9 (14 crew accounts) |
| Files on jobs | 769 |
| Quotes | 180 |

**Out:**
- **60 lost opportunities** (Karan: "no lost jobs"). Win/Loss reports will show
  wins only — worth saying out loud before Alex opens that report.
- 7 canceled work orders, two of which are stamped Blue Chip anyway.
- Everything not `Corporate_Name__c = 'Tomco Painting'`. Filtering on the Tomco
  *record type* would drag in 74 Blue Chip work orders; it is the wrong filter.

**Identity:** Tomco = `Corporate_Name__c = 'Tomco Painting'`. Verified: all 192
opportunities carry it, all owned by Brendan Tomco or Mary O'Sullivan, and none
of the 75 GC accounts carries a non-Tomco opportunity.

---

## 2. Where everything lands

| Salesforce | Commercial | Notes |
|---|---|---|
| `Account` (RT Tomco) | `commercial_accounts` | 75. `sf_account_id` kept for re-runs |
| `Contact` | `commercial_contacts` + `commercial_account_contacts` | 93, primary flag preserved |
| `Opportunity` | `commercial_opportunities` | status mapped below |
| `WorkOrder` | the deal's **project** + `commercial_work_orders` | dates, address, job number |
| `WorkOrderLineItem` (134) | proposal/scope lines | `ChangeOrderRelated__c` kept |
| `WorkOrder.TotalChangeOrder__c` | one `commercial_change_orders` row per job | see §4 |
| `Transaction__c` Purchase (812) | `commercial_project_purchases`, category by type | vendor linked by SF id |
| `Transaction__c` Payment_Out / Labor (790) | purchases, category `labor` | payee → labor vendor |
| `Transaction__c` Payment_Out / Reimbursement (25) | purchases with `reimburse_to` | |
| `Transaction__c` Payment_In (109) | `commercial_invoice_payments` | needs an invoice — §3 |
| `WorkOrderCrew__c` (1,920) | `commercial_time_entries` | `Hours_Worked__c`, `ActualLaborDays__c` |
| `Crew_Worker__c` (9) | `commercial_employees` | so labor reports have people |
| `ContentDocument` (769) | `commercial_documents` + storage | §5 |
| `Quote` (180) | documents, category `proposal` | the PDF as sent, not a rebuilt proposal |

**Status mapping** (`WorkOrder.Status` → deal status · sub-status):

| Salesforce | Commercial |
|---|---|
| Closed | `post_sale_closed` · `closed` |
| Complete Balance Owed | `billing` · `completed_and_invoiced` |
| Work In Progress | `in_progress` · `wip_on_site` |
| On Hold | `in_progress` · `wip_on_hold` |
| Coordination | `pre_construction` · `coordination` |
| Pending | `pre_construction` · `coordination` |
| open bid, no work order | `proposal` · `sent` |

Rows are inserted in their final state with `decided_at` / `closed_out_at` set
directly. Going through `changeOpportunityStatus` would fire team emails, Slack
posts and the proposal cascade on 132 deals.

---

## 3. The money model — the decision that matters

Salesforce has **no invoice object**. Billing lives as rollups on the work order
(`GrandTotal__c`, `TotalPaymentsIn__c`, `BalanceOwed__c`) with the 109 payments
as `Transaction__c` rows. Commercial hangs payments off invoices, and every
money report reads from them.

**Plan: one invoice per job**, dated the job's start, carrying the job's billed
value, with its payments attached. Without it, all 92 jobs read "nothing billed"
and the $1.39M outstanding never appears anywhere.

- **Invoice subtotal** = `Quoted_Subtotal_with_Change_Order__c` (contract incl.
  change orders — the platform's contract basis is pre-tax)
- **Tax** = `Tax` (total $11,207.20)
- **Invoice total** = `GrandTotal__c` — checked per job, not recomputed
- **Payments** = the `Payment_In` rows, each with its own date, method and
  reference. They sum to the rollup on **every** job, so nothing is invented.
- **Status** follows the money: paid / partial / sent

**Verified:** the 109 payment rows sum to $1,300,408.37 and match Salesforce's
own per-job rollup on all 92 jobs — zero discrepancies.

### The seven jobs where Salesforce disagrees with itself

`BalanceOwed__c ≠ GrandTotal__c − TotalPaymentsIn__c` on seven jobs:

| Job | Grand total | Paid | SF balance | Difference |
|---|---|---|---|---|
| 00277843 | 1,087.50 | 1,065.75 | 0.00 | −21.75 |
| 00269035 | 22,620.01 | 22,623.01 | 0.00 | +3.00 |
| 00271332 | 3,795.92 | 4,285.43 | 0.00 | +489.51 |
| 00273063 | 669.04 | 669.00 | 0.00 | −0.04 |
| 00276888 | 762.13 | 761.25 | 0.00 | −0.88 |
| 00281988 | 2,492.19 | 2,491.19 | 0.00 | −1.00 |
| 00302953 | 46,500.00 | 19,000.00 | 29,075.40 | +1,575.40 |

Six are closed jobs written down to zero — short payments accepted, or
overpayments kept. One (`00302953`) is live and is the one to ask Katie about.

**Proposal:** the payment rows are the truth, because they are individually
dated and they reconcile. For the six closed jobs, the small remainder is
recorded as a **write-off adjustment** on the invoice so the job closes at zero
exactly as it does in Salesforce — rather than leaving six jobs showing $21.75
and $1.00 owed forever, or silently inventing a payment that never happened.
`00302953` is imported at the payment-row figure ($27,500 owed) and flagged for
Katie.

Overpayment (`00269035` +$3.00, `00271332` +$489.51) lands as a credit, which
the platform already models.

---

## 4. Change orders

`TotalChangeOrder__c` totals **$189,719.77** across the 92 jobs, but only 37
scope lines are flagged change-order-related, worth $23,000. So the detail does
not exist in Salesforce — only the total per job.

**Plan:** one approved change order per job whose `TotalChangeOrder__c ≠ 0`,
described as "Change orders carried over from Salesforce", dated the job's start.
That makes `contract = original + change orders` come out at
`Quoted_Subtotal_with_Change_Order__c` to the cent, which is what every contract
KPI reads. The 37 flagged lines still import as scope lines with their flag.

---

## 5. Files and quotes

- **769 files** — download each from Salesforce, upload to
  `commercial-documents`, insert a `commercial_documents` row against the deal,
  category by type (proposal / plans / photo / other). Slowest stage; run last so
  a failure never blocks the data.
- **180 quotes** — the quote PDF filed as a document, category `proposal`. Not
  rebuilt as Commercial proposals: a rebuilt proposal would be a new document
  that never went to the GC, and it would show a price nobody signed.

---

## 6. Order of operations

1. Backup (**done** — 3,834 rows, 66 files, 140.9 MB, verified)
2. Wipe: `scripts/wipe-commercial-data.sql`, then `wipe-commercial-storage.mjs`
3. Import, in dependency order, each stage verified before the next:
   accounts → contacts → deals → jobs/projects → scope lines → change orders →
   invoices → payments → purchases/payouts/reimbursements → employees →
   attendance → quotes → files
4. Reconcile (§7)
5. Spot-check on screen: one closed job, one live job, one with an overpayment

Every stage is **idempotent** — Salesforce ids are stored on each row, so a
re-run updates rather than duplicates, and a failed stage can be re-run alone.
Each stage is a dry run first, printing what it would write.

---

## 7. Reconciliation — to the cent

An automated check after import, comparing Commercial against Salesforce:

**Totals:**

| Figure | Salesforce |
|---|---|
| Contract (quoted subtotal incl. COs) | $2,676,983.67 |
| Change orders | $189,719.77 |
| Tax | $11,207.20 |
| Grand total | $2,688,190.87 |
| Collected | $1,300,408.37 |
| Outstanding | $1,389,826.74 |
| Purchases | $433,414 |
| Labor payouts | $545,565 |
| Attendance hours | 14,632.5 |

**Per job**, for all 92: contract, change orders, billed, collected, balance,
purchases, labor cost, hours, margin. Any cent of difference is listed by job and
field, and the import is not called done until the list is empty or every
remaining line is one of the seven known write-offs above.

**Also checked:** 132 deals, 75 accounts, 93 contacts, 35 jobs with a balance
owed, 9 employees, 1,920 attendance rows, 769 files, 180 quotes.

---

## 8. Open questions for Katie

1. **`00302953`** — Salesforce says $29,075.40 owed, the payments say $27,500.
   Which is right?
2. **Six closed jobs** written to zero — record the remainder as a write-off (the
   plan), or leave the few dollars outstanding?
3. **Four "Tomco WIP" internal jobs** (Berks Nordstrom, Stryker, MS Packaging,
   SHOP) — real jobs or internal bookkeeping? Excluding them gives 88, and does
   not change the 35-open count.
4. **No lost jobs** means Win/Loss shows wins only. Confirmed with Alex?

## 9. Risks

- **Files.** 769 downloads and uploads is the longest, most failure-prone stage.
  It is last, and re-runnable, so a partial failure costs only time.
- **Contacts.** 93 contacts across 75 accounts; Salesforce holds one primary per
  opportunity, so per-job contacts beyond the primary may be thin.
- **Attendance without rates.** 9 workers import as employees with no pay rate,
  so labor COST from attendance reads zero until rates are entered — the money
  already paid to crews arrives through the 790 labor payouts, which is the
  figure the reports use. Worth saying to Katie so "labor cost" isn't read twice.
- **Project numbers.** Commercial assigns `YYYY-NNNN` itself; imported jobs keep
  Salesforce's work order number in `ppp_job_number` so both are searchable.
