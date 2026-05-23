<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

---

## Shared PPP Salesforce knowledge base

PPP's Salesforce conventions, KPI definitions, business rules, and process playbooks live in a separate **shared repo** so internal PPP admin work + the Command Center engagement stay in sync across multiple Claude sessions:

**`https://github.com/developer761/ppp-salesforce-reference`** (public — sanitized reference layer only)

Before writing any Salesforce-related code in this project (SOQL, KPIs, schema, business rules, validation), read these in the shared repo:

| Path | What's there |
|---|---|
| `CLAUDE.md` | Index + core conventions + curation rules. Read first. |
| `salesforce/BUSINESS_RULES.md` | Field-name traps, fiscal year, canonical sales metric, GM / `IsClosed` / lead-source gotchas. Read before writing SOQL. |
| `salesforce/REP_PERFORMANCE_KPIS.md` | Exact KPI definitions PPP uses today (the spec for rep profile numbers). |
| `salesforce/DATA_DICTIONARY.md` | Full production schema snapshot. |
| `salesforce/architecture_*.md` | Object-relationship maps (Mermaid). |
| `command-center/REP_PROFILES_INTEGRATION_GUIDE.md` | How to wire PPP's canonical KPIs into THIS app's Rep Profiles. Identifies 6 correctness bugs in the current code (§4) that need fixing before adding new KPIs. |
| `playbooks/` | Repeatable PPP processes (licensee onboarding, sandbox testing, S-Docs templates). |

To pull a fresh local copy any time:

```bash
git clone https://github.com/developer761/ppp-salesforce-reference.git \
  ~/Desktop/PPP/ppp-salesforce-reference
# or to update an existing clone:
git -C ~/Desktop/PPP/ppp-salesforce-reference pull
```

### Quick reference — PPP conventions you can't get wrong

- **Source of truth:** Salesforce. Command Center reads live (5-min snapshot cache); never mirrors.
- **Fiscal year:** Feb 1 → Jan 31. FY name = start year (FY26 = 2026-02-01 → 2027-01-31). Quarters Q1 Feb–Apr · Q2 May–Jul · Q3 Aug–Oct · Q4 Nov–Jan.
- **Primary sales metric:** `Opportunity.QuotedSubtotalWithChangeOrder__c` (Opp uses no underscores; `WorkOrder.Quoted_Subtotal_with_Change_Order__c` uses underscores — same concept, different API name).
- **Rep universe:** active `User` records with **Profile name `*Standard.Field`** (~26 active). Manager team = `Sales_Team_Member` permset.
- **Completed job:** `WorkOrder.Status IN ('Closed','Complete Paid in Full','Complete Balance Owed')`. DO NOT use `IsClosed` — misses the `Complete*` variants.
- **Canonical GM%:** `WorkOrder.Gross_Margin_Percent__c`. NOT `GrossProfitPercent__c` (denominator is `NetValue__c`, inflates margins).
- **Lead source bucketing:** `Opportunity.LeadGroup__c = 'Self-Generated'` → self-gen; everything else (including null) → marketing.
- **Quota:** points 1:1 with dollars. Rep-attributable rows = `QuotaType__c = 'Field_Member'`. **Trap:** `SubQuota__c.CurrentUserId__c` is the VIEWER, not the rep — use `TotalQuota__r.User__c`.

### Cross-Claude convention

When either side (Karan's Claude here, Katie's Claude in the shared repo) changes a PPP convention, KPI, or business rule:
1. Update the relevant doc in `ppp-salesforce-reference/`
2. Commit + push the shared repo
3. The other side picks it up on next `git pull`

This file is the pointer that keeps the connection working — don't remove this section.

### Known correctness backlog from the integration guide

See `command-center/REP_PROFILES_INTEGRATION_GUIDE.md` §4 for the full breakdown. Status of the 6 correctness bugs called out for the current Rep Profiles code:

1. ✅ **Revenue field** — `Opportunity.QuotedSubtotalWithChangeOrder__c` (and WO `Quoted_Subtotal_with_Change_Order__c`) is now the canonical sales metric. `NetValue__c` is kept as the realized/collected fallback. `SnapshotOpp.quotedSubtotal` carries the canonical value; `deriveRepScorecard` attributes sales from it.
2. ⚠️ **Snapshot window** — still filters `CreatedDate = LAST_N_DAYS:365` (the deliberate scale-budget for 89k+ Opps). Documented as a known short-cycle bias. The new fiscal-period scorecard is computed over the same snapshot, so it shares the bias; mitigated by the warm cache + manual refresh button. Re-evaluate if reps complain about missing long-cycle deals.
3. ✅ **"lifetime" label honest now** — rep header reads "Revenue · Last 12 months" with a tooltip explaining the short-cycle scope. The fiscal-period Scorecard now sits below for the real FY view.
4. ✅ **Rep universe constrained** — `SnapshotRep.isFieldStandard` flags Profile `*Standard.Field` reps (~26 active). `deriveRepScorecard` uses this set for `rank` and team denominators. Non-field-standard users remain in the snapshot for owner lookups but don't pollute KPIs.
5. ✅ **Real close rate** — KPI 3 in the scorecard uses `won ÷ created` over Opps `CreatedDate` in the period, split self-gen vs marketing via `Opportunity.LeadGroup__c`. The Opp→WO conversion metric stays on the existing top KPI row for continuity but is clearly labeled "Conversion Rate" (not "Close Rate").
6. ✅ **Real appointments/estimates** — the "Activity" block now reads from KPI 5 (`AppointmentDate__c` + `Estimate_Sent__c` + `Cancelled_Appointment__c`) instead of the opp-count proxy. Falls back to the proxy with an explicit caveat label when only mock data is available.

All 11 new KPIs shipped in `lib/salesforce/rep-scorecard.ts` (% to Goal · GM vs target · Close Rate · Sales Mix · Pricing Discipline · Appointments · Pipeline Health · Production Quality · Money Flow · Commissions · Attendance Completeness data-quality gauge). Rendered on `app/dashboard/rep/[id]/page.tsx`. Validate any rep's numbers against PPP's FPRC reports via:

```
GET /api/admin/rep-validation?repId=<sf-user-id>
GET /api/admin/rep-validation?email=<rep@precisionpaintingplus.com>
```

Returns the full scorecard + the per-KPI input counts + field-coverage flags so you can triage "0 vs missing data."
