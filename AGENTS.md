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

See `command-center/REP_PROFILES_INTEGRATION_GUIDE.md` §4 for the full breakdown. Summary of bugs in the current Rep Profiles code:

1. Revenue field — we use `NetValue__c`; PPP canonical is `QuotedSubtotalWithChangeOrder__c`
2. Snapshot window — filters `CreatedDate` but buckets revenue by `CloseDate`; long-cycle deals lost
3. "lifetime" label — actually last-12-months by created date; relabel or widen
4. Rep universe too broad — should constrain to Profile `*Standard.Field`
5. Close rate definition — Opp→WO conversion ≠ PPP's `won ÷ created` cohort-based metric
6. `appointmentsHeld` + `quotesSent` are fake proxies — use real SF appointment/estimate fields

Plus 11 new KPIs to add after correctness fixes (% to Goal, GM vs target, Rev/Labor Day, Materials %, real appointments, stale pipeline, reviews, complaints, money flow, commissions). Implementation order in §6.
