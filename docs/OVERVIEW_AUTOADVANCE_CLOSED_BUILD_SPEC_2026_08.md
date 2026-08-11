# Overview phase-swap · Auto-advance · Closed column — BUILD SPEC (2026-08)

**For the parallel build session.** Self-contained. The verification session that
wrote this **is not building it** — it will **recheck** against this doc. Every
edge rule below came from a 5-persona + 2-adversarial workflow (130 raw findings →
20 consolidated) run against the design; they are grounded in the real code, so
treat them as requirements, not suggestions.

> ⚠️ Coordination: the ONLY surface where this could collide with the Crew build
> is the deal **Overview** — it's the same page. Serialize if the Crew work is
> touching `app/commercial/accounts/[id]/page.tsx` around the deal drill-in.

---

# PART A — MASTER LIST: everything NOT done

Status of the whole platform after both sessions' work. ✅ done · 🟡 partial · ❌ not built · ⛔ blocked-on-people.

### The three builds this spec covers
1. ❌ **Phase-aware opportunity Overview KPIs** — the deal drill-in shows the delivery "Profitability" block even on a pre-sale bid ($0 empty). Needs the 3-way phase swap (Part B §2).
2. 🟡 **Auto-advance status** — a proposal→status *reconciler* exists but runs on page load and is bidirectional; there's no closeout→Closed, no shared rank, no notification suppression. Needs the engine in Part B §3.
3. ❌ **Visible "Closed" column** — post-sale closed deals currently fall into an overflow drawer; no column. Part B §4.

### Other remaining Katie-list items
4. 🟡 **Tap-to-sign breadth** — signature stored + used in closeout PDF; **verify** it flows into warranty, LoT, contracts, and approval sign-offs (not just closeout).
5. ❌ **Google Drive / Dropbox archive + restore** of project doc drawers — not built (Katie flagged as future; low priority).
6. 🟡 **New-opportunity form parity** — the pipeline slide-out doesn't collect client name/address (proposals hydrate a blank address) and has no duplicate check; the account form does. Bring both to parity (the other session has this queued).

### Crew role — separate spec
7. 🟡 **Crew role** — being built by the other session per `docs/CREW_ROLE_BUILD_SPEC_2026_08.md`. Migration 125 already applied. (Reminder baked into that spec: resolve auth by the explicit `user_id` link ONLY — not email auto-match.)

### Blocked on people (not buildable yet)
8. ⛔ **Reports** — need Katie's list of which reports.
9. ⛔ **Submittals** page feedback — need Stephanie.
10. ⛔ **Letter of Transmittal / closeout** final details + remove COI + signature — need Stephanie/Brendan (template was provided; final specifics pending).

### Verified DONE (do not rebuild)
Change-orders itemized on invoices · AIA templated Excel with Tomco operating-company label · invoice-create under the deal · AR/open-invoice statement · lien-waiver **storage** (upload, not generate) · proposal internal/client (bid notes, marked-up doc, show-price, adjustable final price, Bid Set date, Kim=estimator) · Kim→Brendan approval loop · project rollups (`getProjectFinancials`) · WO-from-proposal builder · operating-company config · pre/post-contract deal **tabs** · notifications preset+custom · statuses (6 pre-contract + post-contract Status→Sub-status).

---

# PART B — FULL BUILD SPEC

## §1. Confirmed decisions (Karan)
- Auto-advance is **automatic + forward-only**.
- Add a **visible Closed column** on the board.
- KPI sets per phase = builder's best fit **with data-availability guards** (below).

## §2. THE shared primitive — `stageRank` (build this FIRST)

There is **no ordinal today** (`ALLOWED_TRANSITIONS` is flat, `laneForStatus` returns a lane not an order). Both the overview and the auto-advance engine need one. Ship ONE helper and forbid re-deriving order anywhere.

`lib/commercial/opportunities/constants.ts`:
```ts
/** Monotonic delivery-progress rank over the (status, sub_status) tuple.
 *  null = a TERMINAL off-ramp that is never "behind" anything and never
 *  auto-moved (lost bids, fully-closed jobs). Used by BOTH the phase switch
 *  and every auto-advance trigger + the reconciler. Do not re-derive order. */
export function stageRank(status: string, sub?: string | null): number | null {
  switch (status) {
    case "qualifying":       return 0;   // (solicitation/rfp/estimating subs all 0 for advance purposes)
    case "estimating":       return 1;
    case "proposal":         return 2;
    case "pre_sale_closed":  return sub === "won" ? 3 : null;      // lost = terminal
    case "pre_construction": return 4;
    case "in_progress":      return 5;
    case "billing":          return 6;
    case "post_sale_closed": return sub === "closed" ? null : 7;   // closeout=7, closed=terminal
    default:                 return null;
  }
}
export const isTerminalOffRamp = (o: {status: string; sub_status: string|null}) =>
  stageRank(o.status, o.sub_status) === null;
```
- Advance rule everywhere: **advance to target T only if `stageRank(current)` is non-null AND `< stageRank(T)`.**
- 12+ tests pinning the ladder + the two null cases.

## §3. Phase-aware Overview — **THREE-way, keyed on STATUS not `isPostSaleProject`**

`isPostSaleProject()` returns TRUE for `won` and FALSE for `lost` — using it as the switch renders a freshly-won job as a broken $0 money-wall and a lost bid as live pipeline noise. Resolve phase in THIS order:

```
1. isLost(opp)                                   → LOST card
2. isWon(opp) && status === 'pre_sale_closed'    → WON-not-started card
3. status ∈ {pre_construction,in_progress,billing,post_sale_closed} → POST-SALE tiles
4. else                                          → PRE-SALE tiles
```

**Performance:** only call `getProjectFinancials(oppId)` on branch 3 (it fans out to invoices+purchases+labor+AIA+COs). Pre/Won/Lost need only sales-lens data — don't pay for it on the common morning pre-sale view.

**Sweep ALL sales-lens surfaces, not just the header strip.** The opp Overview shows Weighted/Probability/Bid in the **header KpiTile strip AND the info-tab cards**. Gate every one on the same resolved phase. **Schedule/lifecycle dates (proposed start/end, RFP received, proposal submitted, time-to-sale) must PERSIST into post-sale** — only the *forecast* tiles (win probability, weighted, decision countdown, bid-as-forecast) are hidden post-sale.

### §3a. PRE-SALE tiles
- **Bid / value:** `dealValueCents(opp, proposalTotal)` WITH the proposal-total fallback (ignore deleted/void proposals). If it's 0 because no bid AND no priced proposal → render **"— / Not priced yet"**, never "$0". Treat a `0` low/high as "not set" so a single real number is a point estimate (not a halved midpoint).
- **Weighted $:** `weightedPipelineCents(opp, proposalTotal)` — same "—" rule when unpriced.
- **Win probability %** + a tooltip rewritten to the **real v2 ladder** (solicitation 10 / rfp 20 / estimating 30 / pending-approval 55 / sent 65 / won 100) — the current tooltip quotes dead v1 statuses.
- **Stage + days-in-stage** — see §5 for the correct ET/anchor math.
- **Proposal status + Bid Set date** and **RFP received / proposed start** — source from `fetchOpportunityLifecycle` and reuse its exact labels (don't re-derive "Bid Set"; confirm its mapping with Katie).
- Drop the "Decision in" countdown once decided/in-delivery (it shows "X days overdue" on a won job).

### §3b. POST-SALE tiles — use the REAL `getProjectFinancials` field names
`getProjectFinancials` returns: `contractCents, hasContract, invoicedCents` (WITH tax), `billedPreTaxCents` (PRE-tax), `collectedCents, openBalanceCents, creditCents, totalCostCents, grossMarginCents, grossMarginPct, fieldOpsLaborCents, laborUnratedHours`. **There is no `billedCents`.** Map exactly:

| Tile | Source | Rule |
|---|---|---|
| Contract value | `contractCents` (already base + net approved COs) | show CO delta as sub-line "base $X + $Y COs". Expose provenance: if it's a **bid midpoint** (no proposal/AIA), label **"Contract (est. from bid)"** provisional, and caveat all dependent %s. |
| Billed % | **`billedPreTaxCents / contractCents`** (both pre-tax) | matches the invoices-tab tile. NEVER `invoicedCents/contract` (tax makes it ~108%). |
| Billed $ headline | `invoicedCents` (with tax) | matches the AR statement. |
| Collected | `collectedCents` | |
| Outstanding AR | **`openBalanceCents`** (Σ per-invoice max(0,balance)) | NEVER `invoiced − collected` (a credit on one invoice would mask another's open balance / go negative). If `openBalanceCents===0 && creditCents>0`, show a **"Credit $X"** chip, never negative AR. |
| Costs to date | `totalCostCents` | |
| Gross margin $/% | `grossMarginCents` / `grossMarginPct` | see guards below. |
| % complete | **AIA `percentCompleteBps`** (or Field-Ops progress) — NOT money | if no real source, label the tile **"Billed %"** or "— / not tracked". Never derive physical % from billing. |

**Post-sale guards (all required):**
- **`contractCents <= 0` → treat as `hasContract=false`**: show "Contract not set yet — add a proposal total" empty state, **suppress** %billed / GM$ / GM% (never render NaN/Infinity/negative GM); still show absolute costs + collected.
- **`totalCostCents === 0`** → label GM **"Projected gross margin"** / "No costs booked yet", not a triumphant "100%".
- **`laborUnratedHours > 0`** → badge GM "margin understated — N crew hours have no cost rate."
- Margin below **−100%** → show "over budget" language, not a `-4000%`-looking number.

### §3c. WON-not-started card (branch 2)
Outcome + **contract-to-be** + proposed start + a **"Start Project" CTA**. Suppress billed/collected/AR/%complete (structurally 0). This is the bridge so a won-but-not-started deal never shows the empty post-sale money wall. (Note for the builder: lane and phase intentionally diverge here — the board files `won` under the pre-contract Closed cluster while the detail page shows this card.)

### §3d. LOST card (branch 1)
Pill + `loss_reason` + `decided_at` + final bid for reference. **No** probability/weighted/countdown/money. **Gate `loss_reason` on `win_loss_debriefed_at`:** if null (or the cascade auto-set `'other'`), show "Lost · reason not recorded — Debrief pending" with a link, never a blank or the placeholder.

### §3e. "Has delivery activity" safety net
If a deal has ANY issued invoices / collected cash / costs but its **current** status is pre-sale (reopened, or dragged back in a dispute), don't let the money vanish: keep a money summary/banner ("$X invoiced · $Y AR") visible regardless of the pre-sale status, and **warn (never reject)** before reopening such a deal that reopening hides the money.

### §3f. Mobile (375px)
Post-sale is 7–8 tiles; `grid-cols-2` wraps to 4 rows and buries the status pill/toolbar/tabs below the fold. Show the top 3–4 (**Contract · Billed % · Outstanding AR · GM%**) above the fold with the rest behind a "more" expander or a horizontal-scroll strip; keep the **status/phase pill above** the money; `formatCentsCompact` + `tabular-nums` so no value wraps mid-number. Test 360–390px explicitly.

## §4. Auto-advance status engine

**ONE authority principle.** The bidirectional `reconcileDealStatesFromProposals` already owns proposal-driven stages (Estimating/Proposal). The live `createProposal` cascade also writes status. Do **not** add a third writer with its own guards. Instead:
- Route everything through **one shared guard + write path** that uses `stageRank`.
- Make the **reconciler forward-only too** (share the guard): it may heal UP (`stageRank(current) < stageRank(target)`) but never DOWN. Backward correction becomes manual-only. Regression test: advance → open a new R2 draft → a reconcile pass must LEAVE the deal at Proposal (today it yanks back to Estimating — the ping-pong).

### §4a. Triggers — defined by the RESULTING status, via the existing `derive()` map (not the word "Proposal")
| Event | Target (via `derive()`) | Notes |
|---|---|---|
| Proposal **draft / pending / approved** created/edited | **Estimating** | a draft is NOT the Proposal stage; advancing to Proposal fabricates a "Sent" deal with no PDF/approval and bypasses the R1d send-gate. |
| Proposal **sent** | **Proposal** | |
| Proposal **won** | **pre_sale_closed·won** | **cap here.** |
| **Closeout completed** | post_sale_closed·closed | §4c special-case, not a rank advance. |

Each fires **only if `stageRank(current) < stageRank(target)`** and current is not a terminal off-ramp.

### §4b. Triggers to DROP (adversarial pass killed these)
- ❌ **won → Pre-Construction**: bypasses the manual "Start Project" gate + the Win/Loss debrief, and — because `pre_construction` isn't terminal — never stamps `decided_at`, so `wasWonInPeriod()` **drops the win from "Wins this month."** Keep Start Project manual.
- ❌ **first invoice → Billing**: commercial bills DURING production (AIA draws); this marks a 15%-done job "Billing" and forward-only never returns it. Drop, or gate to fire ONLY from Substantial Completion.
- ❌ **work order sent → delivery**: a WO must never be the thing that crosses a deal pre→post (it'd cross an un-won bid into delivery with no recorded win → invisible in win counts). Gate any WO trigger on `isWon` already being true.

### §4c. Closeout → Closed is a sub-status refinement, not a stage advance
`(post_sale_closed, closeout) → (post_sale_closed, closed)` is same top-level status, so `changeOpportunityStatus` writes no log/notification/column-move. Make it **edge-triggered on the transition INTO complete only**, idempotent (already `·closed` → no-op). Surface via a card **badge** ("Close-Out Docs" amber vs "Closed" neutral), not the status-changed path. While Closed, **block/warn** on marking the closeout incomplete so the two can't diverge.

### §4d. Guards that apply to EVERY auto-advance (all required)
1. **Terminal no-op:** if `isLost(opp)` OR fully-closed → hard no-op; never targets a lost/terminal state (avoids placeholder `loss_reason='other'` pollution). Re-engaging a closed deal is an explicit human Reopen.
2. **Manual wins:** do NOT fire if the deal's most recent `status_log` row is a **human** move (`acting_user_id != null`) newer than the triggering artifact — an admin's fresh re-qualify must not be auto-reversed. ("Forward-only" alone doesn't protect this.)
3. **Idempotent + atomic:** perform a **conditional update** `UPDATE … WHERE id=? AND stageRank(status) < stageRank(target)` so the DB enforces monotonicity and a concurrent human drag can't be clobbered (0 rows = no-op).
4. **One write per request:** collect all fired triggers, compute the **single max** target rank, apply exactly one advance (one write, one `status_log` row, one notification). Never fold sequentially.
5. **Notification suppression:** thread a `source` (`'user' | 'auto_advance' | 'reconcile'`) through `changeOpportunityStatus`. For non-user sources: still write audit/`status_log` but **suppress the team email/bell** (timeline reads "Auto-advanced to Estimating — proposal created", not "PPP admin moved…"). **Also sweep the existing reconciler** — it currently fires the whole-team fan-out with `acting_user_id:null` on every render (pre-existing spam bug).
6. **No cascade re-entry:** pass `_skipProposalCascade:true` + `_skipDagCheck:true` (match reconcile's contract); strictly deal-side; re-entrancy guard so one auto-advance can't schedule another in the same request.

## §5. Visible Closed column

Add `post_sale_closed` so cards land in a real column, but don't flood the board with dead history.
- **`bucketOpps`:** pre-seed `post_sale_closed` into `byStatus` (cards land in the column), BUT compute `anyOnBoard` from **OPEN columns only** so a fully-closed account stays off the live board. Only render the Closed column inside accounts that also have active work; surface closed-only accounts via a separate collapsed "Completed / Closed jobs" affordance.
- **Distinct header:** the pre-sale cluster already shows "Closed Won/Closed Lost" and `post_sale_closed` is labeled bare "Closed" — three "Closed"s. Give the post-contract column header **"Completed"** or **"Closed · Delivered"** (reuse `kanbanMoveToLabel`'s disambiguation on the header, not just the menu). Lane headers ("Pipeline" vs "Delivery") help too.
- **Cap + reopen:** give it its own display cap (10, like `TERMINAL_DISPLAY_CAP`) with overflow sorted `decided_at desc`, or make it scroll. On drop, **pin the just-moved card to the top** so it doesn't vanish into overflow. Header "Showing 10 of 31 · view all". The column must be a valid drop target for BOTH close and **reopen** drags; overflow cards must stay reopenable.
- **Drop-target semantics:** `COLUMN_TARGET.post_sale_closed` writes `(post_sale_closed, 'closeout')` = "docs pending", which `FULLY_CLOSED_SUB_STATUSES` excludes — so drag-drops read as not-fully-closed and mix "owes paperwork" with "done." Decide the column's meaning and align `COLUMN_TARGET`, the closeout auto-advance, and `FULLY_CLOSED_SUB_STATUSES` to ONE story; render a sub-status badge inside the column. Add the **skip-if-same-column guard** the Proposal column uses (don't issue a write when the card's `columnKeyForOpp` is already `post_sale_closed` — otherwise a `·closed` card gets downgraded to `·closeout`).
- **Reopen clears `decided_at`:** moving OUT of `post_sale_closed` into an active delivery stage keeps a stale `decided_at` today (the clear only fires for `PRE_SALE_OPEN_STATUSES`). Extend the clear to delivery-lane reopens so reopened jobs drop out of closed rollups; re-stamp on genuine re-close. **Warn** on `post_sale_closed → reopen`, and note the reconciler will fight a post→pre drag (proposal still `won` → bounces back).
- **Guard cross-lane drops:** a pre-sale card dropped straight onto post-sale Closed jumps lanes and is **never counted as a win** (`wasWonInPeriod` excludes `post_sale_closed`) → silent win hole + fabricated close date. Add "pre-sale → post_sale_closed/any post-sale" to `WARN_TRANSITIONS` ("This deal was never marked Won — mark it Closed anyway?").

## §6. days-in-stage math (used by pre + post headers)
Not a raw UTC ms floor (off-by-one in ET evenings, disagrees with the ET "Decision in" on the same card). Use the ET helper (`daysFromTodayEt` / `anchorDateOnlyIso`). Fall back to `opp.created_at` when no `status_log` row exists (backfilled deals). Anchor to first entry into the **top-level** status; do **not** reset on sub-status refinements or system reconciles (exclude `changed_by_user_id IS NULL` rows) so a cosmetic auto-move doesn't hide a stale deal.

## §7. File-by-file
| File | Change |
|---|---|
| `lib/commercial/opportunities/constants.ts` | `stageRank` + `isTerminalOffRamp` (§2) |
| `app/commercial/accounts/[id]/page.tsx` (deal drill-in `ProjectHome`) | 3-way phase swap of the Overview tiles (§3); gate `getProjectFinancials` on post phase; sweep header strip AND info-tab cards; mobile layout |
| `app/commercial/opportunities/[id]/page.tsx` | same phase swap on the standalone deal page (deep-link/deleted-deal surface) |
| `lib/commercial/opportunities/status.ts` / wherever `changeOpportunityStatus` lives | `source` param + notification suppression + conditional atomic update (§4d) |
| `lib/commercial/proposals/db.ts` | make `reconcileDealStatesFromProposals` forward-only via `stageRank`; route create/send cascade through the one guard |
| closeout completion action | edge-triggered `→ closed` refinement (§4c) |
| `lib/commercial/opportunities/kanban-columns.ts` + board page + DnD | visible Closed column, header label, cap, drop guards, `WARN_TRANSITIONS` (§5) |
| `__tests__/commercial/*` | stageRank ladder; forward-only reconcile (advance→new-draft→reconcile stays put); phase 3-way (won/lost/in-delivery); AR=openBalance; contract=0 guard; closeout idempotent; closed-column bucket/cap/reopen |

## §8. Definition of done
- Phase resolves 3-way; won-not-started shows the WON card (not $0 wall); lost shows the LOST card; in-delivery shows correct-field-name money tiles with every guard; pre-sale shows sales tiles with "—" (not $0) when unpriced.
- All money math reconciles with the invoices tab + AR statement (same `billedPreTaxCents`/`openBalanceCents`).
- Auto-advance is forward-only via the ONE `stageRank`, idempotent+atomic, one write/notification per request, suppressed team spam, manual-wins, terminal no-op; the reconciler no longer fights it.
- Closed column visible where there's active work, distinct header, capped, reopen-safe, warns on cross-lane/never-won drops.
- `tsc` clean, full test suite green (+ new tests), production build green, 360–390px verified.

## §9. What the recheck will verify
Every "scoped/guarded" claim against the actual query — the last two rounds caught a security leak and two bugs in freshly-shipped work, and this design's #1 risk is a builder wiring `invoicedCents/contract` or `invoiced−collected` and shipping a number that silently disagrees with the invoices tab. The recheck will specifically hit: won-not-started ($0 wall?), contract=0 (NaN/negative GM?), AR with a credit (negative?), reconciler-vs-advance ping-pong, auto-advance team-spam, and the Closed column flooding a fully-closed account's board.
