# Remaining plan — Commercial CC (updated 2026-08-15, post-audit-remediation)

Supersedes the earlier 08-15 draft and `REMAINING_PLAN_2026_08_14.md`.
The 4-lens adversarial audit (**52 findings**) is **fully remediated** — all
three severity tiers shipped this session. What's left is **last night's build
order** (C.9 → C.5 punch-lists → Phase D re-audit → endgame).

**Verified this session:** `tsc` clean · 813 tests green · `npm run build` exit 0.
~24 commits on `origin/main`.

---

## ✅ 0. DONE — the 52-finding audit (all three tiers)

### 🔴 Emergencies (9) — money corruption / data loss / security
F1 won-deal re-quote no longer wipes the signed contract · F2 AIA G702/G703 foot
after a post-seed CO (+ issued certs frozen) · M1 bulk-delete releases ticked COs
· M2 Original-Contract-Sum stops double-counting COs · D8 archive drops debt not
just revenue · U1 4.5 MB upload cliff closed (submittals direct-to-storage, crew
photo shrink, form-loss guards) · FO1/FO2 no pay for marked-off/back-dated days ·
FO3/FO4 deactivated crew can't file hours, crew can't seed exclusions · D1 under-
contract jobs stay on the by-customer board.

### 🟠 High (~25)
M3/M5 row-cap under-counts paginated · M4 margin-tile basis · D2/D3/D5/D9/D17/D21
report contradictions · D4/D10/D11/D18 filter+CSV drops · D12/D20 report-tab/donut
· N6/N7/N15/N16/N19 notifications · E1 crew-email `.ok` · DOC2/DOC4 · FO5/FO6/FO7 ·
MOB cluster (date-×, saved-pill, chip-×, slide-out scroll-lock).
- ⚠️ **One not landed:** "last-row won/lost popover clipped by overflow-hidden" —
  couldn't reproduce across kanban / status-picker / proposal-drag. Needs Karan to
  point at the surface, or it's a non-surviving finding.

### 🟡 Medium (substantive)
evaluateRule surfaces query errors (no false success) · DOC7 transmittal soft-delete
guard · DOC11 contact-email dedup · DOC14 accounts-search filter preservation ·
N14 ⌘K rename/won-lost.
- **Left (lowest-value edges, not silently dropped):** >1000-row pagination on the
  overdue-tasks / expiring-docs / reconcile crons (unreachable near-term) · D6
  milestone past-due-at-noon TZ (cosmetic) · DOC17 fresh-install approver copy ·
  DOC15/12/13/18 (orphaned upload bytes, error-cause discard, undo-toast-on-fail) ·
  fiscal-year-January config note.

---

## 🔜 1. Last night's punch-lists — build order C.9 → C.10 → C.7 → C.6 → C.8 → C.5

> ⚠️ **Cross-check first.** This session's High/Medium work overlaps several
> last-night items — verify each isn't already fixed before re-doing it. Known
> overlaps to confirm: **C.7 F6** (AIA original-contract) ≈ M2/pickContractBase
> (likely done) · **C.7 F10** (due-date TZ) ≈ N6 (invoice) done / D6 (milestone)
> left · **C.6 C2** (void hard-deletes CO billing) — the single-void path already
> calls releaseTickedChangeOrders; confirm · **C.8 R1** (dealMargin billed-based)
> ≈ M4 (post-job tile done) — confirm dealMargin() itself.

- [x] **C.9 — Auto-advance follow-ups** — ✅ ALL FOUR already resolved by prior
  fixes; the audit doc predates them (verified 2026-08-15, no new code needed):
  - **A1** (won↔lost re-decision restamps `decided_at`) — DONE at
    `status.ts:331` (`toPreSaleClosed && (…|| beforeRow.sub_status !== effectiveSubStatus)`).
  - **A2** (`markProposalOutcome` 2nd unguarded writer) — DONE at
    `proposals/db.ts:967-999`: the won case routes through
    `autoAdvanceOpportunity('won', source:'auto_advance')` (engine's forward-only
    guard declines on a lost deal); the direct lost write now passes `source`.
  - **A3** (direct pre-sale→delivery jump stamps `decided_at`) — DONE at
    `status.ts:334` (`toInDelivery && !beforeRow.decided_at`).
  - **foldAutoAdvanceTargets** — WIRED into the drift reconciler
    (`proposals/db.ts:2754`), no longer dead.
  Covered by `auto-advance-engine.test.ts` + `decided-at.test.ts` (green).
- [x] **C.10 — Deal drill-in navigation** — ✅ done (2026-08-14). Swept the class:
  - change-orders / AIA / costs / work-order / closeout now render **inline** on
    the deal's Project sub-tab (prior restructure); their back arrow returns to
    the origin tab even after a save (the `from`-threading work above).
  - **proposals** — opening one from the deal already carries
    `?back=/commercial/opportunities/<id>?tab=proposals#deal-proposals`
    (`deal-proposals-section` + page.tsx:2893), honoured by the proposal page's
    "Back to Proposals". Clean.
  - **submittal detail** — returns to the deal's Submittals tool, with `from`
    carried through the detail page's opaque `?back=` (the threading work above).
  - **invoice editor** — `?from=<deal invoices tab>` already returned to the deal.
  - **invoice builder** (`/commercial/invoices/new?opp=`) — was the one real
    break-out: its back arrow hard-pointed at the global list, ejecting you from
    the deal. Now takes a validated `?from=`; the deal's two "New invoice" links
    stamp the deal invoices tab, so the arrow comes home (create already forced a
    return to the deal via `void rt`). Other origins keep the global-list default.
- [ ] **C.7 — Flow + logic remainder** (`FLOW_LOGIC_PUNCHLIST_2026_08.md`): F1/F2
  ✅ done; remaining F3 (`decided_at`), F4 (no-bid reclassified), F5 (void→draft
  keeps a payment), **F6** (AIA original-contract — confirm vs M2), F7–F9
  (drag-to-Proposal revert, Start-Project maze, lost-flip leaves the account),
  **F10** (due-date TZ — confirm vs N6/D6).
- [ ] **C.6 — Completeness (20 gaps)** (`COMPLETENESS_PUNCHLIST_2026_08.md`):
  money/dispatch first — **C2** (void hard-deletes CO billing — confirm) · C3
  (tax-exempt skipped on CO path) · C4 (delete-confirm understates cascade) · C5
  (deactivated employee still scheduled) — then ~9 mutations that swallow their
  failure Result (C7–C10), then C1 (proposal PDF hardcoded footer → thread
  `getOperatingCompany`).
- [ ] **C.8 — Re-audit remainder R1–R23** (`REAUDIT_SHIPPED_2026_08.md`): **R1
  first** — confirm/flip `dealMargin()` to billed-based (auto-fixes R2/R12/R17/
  R21/R22), then R3 (Closed-column flood-guard), R4 (crew welcome <10min
  suppression), R5/R6 crew scope, R7–R16 half-solves.
- [ ] **C.5 — Consistency (27 items)** (`CONSISTENCY_PUNCHLIST_2026_08.md`):
  surgical batch (H3, M1, M4–M6, L2–L9) now; five (H1/H2/H4/H6/M7) gated on
  Karan's D1–D5 answers.

## 🔬 2. Phase D — full re-audit
- [ ] Fresh persona + adversarial agents over everything A–C. Non-negotiable: this
  round's audits caught a live security leak and bugs in code written minutes
  earlier.

## 🏁 3. Endgame — road to done
- [ ] Reports suite — **blocked on Katie** (which reports).
- [ ] RFP email → auto-populate the opportunity — **walk the parsing rules with
  Karan**, not spec'd blind.
- [ ] **STOP → joint smoke test with Karan → DONE.**
- *(Parked: Foreman Daily Log — "don't need it for now".)*

---

## Pending on people (not buildable)
Reports → **Katie** · Letter-of-Transmittal specifics → **Stephanie/Brendan** ·
first+last-name sign-off → **Brendan** · Katie #3 / #8 / F2 → **Katie** · Proposal
page order → **Stephanie**.

## One pending confirmation (Karan, 30 s)
- [ ] **Migration 137 (storage RLS):** upload a file on Documents or a Work Order
  from the browser. Server side is wired; the authenticated PUT can't be exercised
  via the service-role path.
