# Post-audit punch list — shipped Opp/Project restructure (verification session, 2026-08-12)

A full multi-persona post-audit (Karan / Katie / Alex + 6 technical lanes + completeness critic;
45 agents, every finding independently re-verified) of everything the 10-step restructure shipped
(steps 1-10 + grace periods, status picker, 404 fix, activity rail, inline editing, de-dup, Brendan
field-drop). **47 verified findings** (45 from the sweep + 2 from the `7e462d9` audit it predated).

## VERDICT: not perfect per Karan's bar yet
The skeleton is sound and the 10 steps landed — but this surfaced real, code-grounded defects across
money integrity, a silently-broken core feature, a platform-wide timezone class, an RBAC fail-open,
and a wide swath of mobile-touch + completeness gaps. **Three classes stand between shipped and perfect:**

1. **The post-mig-127 proposals↔opportunities embed ambiguity** — `070f78b` swept only the 3 crashing
   detail-page queries. The SAME missing `!commercial_proposals_opportunity_id_fkey` hint silently breaks:
   **the Account 360 Proposals tab (ZERO proposals for EVERY account, error swallowed)**, bulk-delete-drafts
   (errors 100%), and the `proposal_idle` cron rule (never fires). One FK-hint sweep fixes all — AND surface
   the swallowed errors so the next break isn't silent. Sites: `accounts/[id]/page.tsx:4238`,
   `proposals/db.ts:1661`, `cron/custom-notification-rules.ts:206`, `competitors.ts:399`,
   `win-loss/reports.ts:323`, `proposals/page.tsx:250`, `overdue-tasks.ts:57`.
2. **Margin-basis disagreement (breaks decision D2)** — the stage-KPI strip is fed CONTRACT-based
   `grossMarginPct` and labels it "Margin/Projected/Final", while the Costs tab, dashboard P&L, and both
   reports use BILLED-based margin. Same deal shows **90% atop the home and 50% one tab-click away**; three
   report captions state a contract-based formula their own billed-based code contradicts.
3. **Platform-wide bare-DATE timezone math** — DATE columns wrapped in `etDateOf`, and `getTime()` on bare
   DATEs, produce ET-evening off-by-ones that read **on-time work as overdue**; inline-editing the TIMESTAMPTZ
   `rfp_received_at` as a bare string corrupts the stored instant so two UIs disagree. Fix `fmtEtDate`'s
   bare-date guard once + route DATE raw / TIMESTAMPTZ through a noon anchor consistently, and sweep.

---

## 🔴 HIGH (7)

1. **Account 360 Proposals tab silently empty — `accounts/[id]/page.tsx:4238`.** The `commercial_opportunities!inner`
   embed (no fkey hint) → PGRST201 post-mig-127; the `{ data }` destructure swallows the error → the Proposals
   tab renders ZERO proposals for EVERY account. Fix: add `!commercial_proposals_opportunity_id_fkey`, surface the error.
2. **Stage-KPI strip shows CONTRACT-based margin under "Margin" — `opportunities/[id]/page.tsx:1531` → `stage-kpis.ts:158-227`.**
   Contract $500k / billed $100k / cost $50k renders "Margin 90% good" atop the home; the Costs tab shows 50%. A costs-booked
   /nothing-billed job prints a confident positive % where `dealMargin` correctly shows "—". Fix: feed `dealMargin(pathFin)` (billed-based).
3. **Toolbar + CSV-export URL builders drop `mine`/`new`/`lane` — `opportunities/page.tsx:789`.** `baseParams` + every
   builder re-add only the old whitelist; on "Under contract"/"My opportunities" any sort/toggle silently widens to ALL deals,
   and Export CSV exports the wrong wider dataset. Fix: add mine/new/lane to baseParams + the export route (or derive from the saved-views helper).
4. **[known #4, worse] Stage-KPI date tiles wrap DATE cols in `etDateOf` → proposal due TODAY reads "1 day overdue" — `opportunities/[id]/page.tsx:1519-1520`.**
   `proposal_due_at` (mig 028) + `follow_up_at` (mig 052) are DATE; `etDateOf("2026-08-12")` → "2026-08-11". One instance of the platform-wide class below.
   Fix: `?.slice(0,10)` for DATE cols; reserve `etDateOf` for TIMESTAMPTZ.
5. **Inline-editing `rfp_received_at` (TIMESTAMPTZ) writes a bare date → a day early; two UIs store two values — `inline-fields.ts:93`.**
   Bare `2026-08-12` coerces to UTC midnight = 8pm ET Aug 11; the account forms anchor to noon. Fix: anchor TIMESTAMPTZ date fields with `anchorDateOnlyIso` (noon).
6. **Inline-field textarea has no `text-base` on mobile → iOS Safari zooms and never returns — `inline-field.tsx:65`.** The `<input>`
   branch fixes this; the `<textarea>` branch regressed it. Fix: `text-base sm:text-[13px]`.
7. **[NEW, `7e462d9`] Editing a deal NULLs `proposed_start_at`/`proposed_end_at` — `accounts/[id]/page.tsx:1548-1553` + `mutations.ts:273-274`.**
   The Brendan field-drop removed the form inputs but the edit action defaults these to `null` (not `undefined`), and the patch-builder writes any non-undefined value → every edit wipes the proposed dates. Contradicts "nothing already entered is lost." Fix: default to `undefined` (like `probability_pct` at 1535).

---

## 🟠 MEDIUM (18)

- **Delivery list header total sums bid midpoint, not contract [known step-7] — `opportunities/page.tsx:729` (`db.ts:412`).** Dashboard tile and the list it links to show different money for the same jobs.
- **List rows never phase-swap to project fields (§5.3) — `opportunities/page.tsx:2790`.** A delivered $475k job reads "$450k–$500k bid · 100% confident" (a sales probability on a won job); PM + % billed absent.
- **[known #3] Status path renders SKIPPED stages as completed (green check) — `status-path-bar.tsx:127`.** `stateFor` only returns passed/current/future; the "skipped" variant is dead.
- **Delivery path bar lights Pre-Construction as "current" on a won-not-started deal — `status-path-bar.tsx:277`.** Contradicts its own comment; won-not-started is indistinguishable from in-pre-construction. Fix: pass a sentinel (not null) so all stages read "future/all-ahead".
- **Job-costs report: header says contract-based margin, code + footer are billed-based — `reports/job-costs/page.tsx:73`.** Same page states two opposite formulas.
- **Geography report caption "Margin is contract-based" but code is billed-based — `reports/geography/page.tsx:95`.**
- **No branded single-invoice PDF (Katie decision #1 unbuilt) — `invoices/status.ts:95`.** "Mark as sent" flips status but renders/emails nothing; the CO-itemization has no document to surface it on.
- **Wins-vs-last-month delta uses two "won" definitions — `page.tsx:197`.** Baseline counts legacy close-outs that `wasWonInPeriod` excludes → false "↓ vs last".
- **`proposal_idle` cron rule never fires (embed ambiguity, silent) — `cron/custom-notification-rules.ts:206`.**
- **Bulk-delete draft proposals errors 100% (embed ambiguity) — `proposals/db.ts:1661`.**
- **Old deal drill-in deep links no longer redirect — `accounts/[id]/page.tsx:354`.** `resolveTabParam('projects')→'deals'` returns before drill-in handling, so `inDealDrillIn` is always false and the redirect block (366-387) is dead; old bookmarks land on the deals list with project+dt dropped, and "Back to Deal" resolves to that dead list.
- **Sidebar `activeOverride` points at step-8-retired hrefs — `commercial-sidebar.tsx:203`.** Proposal builder + submittal-detail pages show NO active nav item.
- **Orphan account-scoped submittal DETAIL route still live (not redirected) — `accounts/[id]/submittals/[dealId]/[sid]/page.tsx:169`.** Traps old deep links + all its save/status redirects in the retired namespace.
- **Crew boundary is layout-only (App Router doesn't re-run layouts on soft nav) — `commercial/layout.tsx:73`.** Pages have zero crew check; a crew soft-nav to `/commercial/opportunities/<id>` renders contract value + delivery tools. Low live exploitability today, but a fail-open by design. Fix: enforce in a per-page/data-loader helper or middleware.
- **Two duplicate filter-chip strips with inconsistent removal — `opportunities/page.tsx:1325`.** SavedViewPicker chips AND a legacy "Applied:" strip both render; removing the same-looking chip from one keeps mine/new/lane, from the other silently clears them.
- **Billing-stage KPI never shows retainage held (plan §7) — `stage-kpis.ts:169`.** $25k retained on a $500k job is invisible on the strip §7 built to show it.
- **List "Hot" filter subtracts `Date.now()` from a bare DATE — `opportunities/page.tsx:633`.** A proposal due today drops out of Hot after ~8pm ET.
- **Dashboard `relativeLabel(proposal_due_at)` raw getTime → "Due today" flips to "Due yesterday" in ET evenings — `page.tsx:821`.**
- **`fmtEtDate` on bare DATE is platform-wide — `invoices/format.ts:61`.** WO scheduled dates + field-ops `work_date` render a day early (payroll label off). Fix once (bare-date guard), repairs all sites; drop the ad-hoc `T12:00:00Z` anchors.

---

## 🟡 LOW (22) — grouped

**Mobile touch targets < 44px:** inline-field pencil 24px (`inline-field.tsx:135`); stage-KPI parent links 24px (`stage-kpi-strip.tsx:50`); saved-view chip remove-X 24px (`saved-view-picker.tsx:125`); activity "Add task" 32px (`activity-rail.tsx:72`).
**Mobile layout:** activity rail buried below the whole InfoTab on mobile (`opportunities/[id]/page.tsx:2042`); status-path chevron row has no overflow-x container → body scrolls sideways at ~640-680px (`status-path-bar.tsx:189`).
**Dates (the bare-DATE class):** InfoTab RFP row uses UTC slice while the KPI uses etDateOf → same date shows two values (`opportunities/[id]/page.tsx:3170`); activity row date badge DD/MM from raw UTC slice, can fall outside its month header (`activity-rail.tsx:44`); `newFilter` compares UTC-sliced created_at to ET cutoff (`opportunities/page.tsx:655`); dead fragile ET-today round-trip var on dashboard (`page.tsx:210`).
**Money / labels:** account deals-row shows bid range/"—" for won deals, never contract (`accounts/[id]/page.tsx:3920`); dashboard "Owed to us" dead identical-branch ternary (`page.tsx:436`); "Gross revenue · billed to date" tile shows a non-cumulative sparkline that can fall (`page.tsx:370`); "Active GCs" counts every non-deleted account (`page.tsx:434`).
**Completeness (plan §7 / §4.6):** closed-stage KPI shows "closed N days ago" not warranty expiry (`stage-kpis.ts:229`); proposal-sent KPI omits "viewed?" (`stage-kpis.ts:128`); send-document surface §4.6 unshipped + latent Brendan BCC dedup leak on multi-CC (`proposals/email.ts:137`).
**Security (latent):** `updateCommercialOpportunity` still accepts a bare `status`/`sub_status`/`loss_reason` write bypassing `changeOpportunityStatus` (no callers today, but one future form → won with no decided_at/audit/project) (`mutations.ts:245`).
**UI micro:** deal tab-bar mobile fade gradient always painted even when tabs fit (`opportunities/[id]/page.tsx:2008`); one record shows three names — "Opportunity" (URL) / "Deal" (back button `tool-back-header.tsx:62`) / "Projects" (breadcrumb :99) — Katie drove the rename.
**[NEW, `7e462d9`]:** deal page still DISPLAYS proposed start/end (`opportunities/[id]/page.tsx:3144/3149`) though the commit dropped them — shows "—" for new deals + the values get wiped by HIGH #7. Also: `POST_CONTRACT_COLUMNS` dead import (`opportunities/page.tsx:80`); `KpiTile` now a dead function (`opportunities/[id]/page.tsx:5356`, from `50bdd2c`).

---

## Note on scope
This is the verification session's punch list; the build session owns the fixes. The three top classes
(embed sweep, margin basis, bare-DATE) each fix many findings at once. Full per-agent detail:
`.../subagents/workflows/wf_058d29c7-24a/journal.jsonl`.
