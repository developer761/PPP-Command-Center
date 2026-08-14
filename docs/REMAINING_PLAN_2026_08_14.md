# Remaining plan — Commercial CC (2026-08-14, end of night)

## ⏰ 0. FIRST THING WHEN YOU WAKE UP — the Vercel deploy is STALLED
**Confirmed live before bed:** KPI strip = **one row**, Project-tab cards now sit
**below** the tab bar. ✅

**NOT yet live:** the Project-home **redesign** (`8697c81a` — cards fill the row,
tool icons, no blank space, fixes the "scrappy / blank space" look). Vercel's
last successful deploy is `beca888`; every push after it — `8697c81a`, `d090b9cf`,
and two empty nudge commits (`90b466e0`, `aa483639`) — **did not trigger a deploy
at all** (no queued / building / failed row). Deploys worked fine earlier today
then abruptly stopped → almost certainly **Vercel Hobby's daily deploy cap** hit
after a huge number of pushes from both sessions today (silent stop, no error —
same class as the cron-limit gotcha).

Code is verified clean 3 ways: **CI Vitest green · `npm run build` green (exit 0)
· all commits on `origin/main`.** Nothing is lost — this is a delivery cap, not a
code problem, and it resolves itself when the cap window resets.

- [ ] Vercel → **Deployments**: if a row for `aa483639`/`8697c81a` is now **Ready**,
  the cap reset overnight — you're done.
- [ ] If still nothing: **⋯ → Redeploy** on the top row. If it goes through → great.
  If it's blocked / errors about limits → it's the daily cap; it'll deploy on the
  next reset, or upgrade to Pro to unthrottle heavy-build days.
- [ ] Once live: hard-refresh (**⌘⇧R**) → WON deal → **Project** tab → confirm the
  tightened cards (filled rows, icons, no empty columns).
- [ ] Do the **Migration 137** upload check (§5 below).

---

Ordered. Top of the list is the other session's audit findings. Stephanie's list
is **DONE** (shipped by the other session) — removed from the endgame below.
Build order from the MASTER_PLAN: **C.9 → C.10 → C.7 → C.6 → C.8 → C.5 → D → E**.

---

## 1. Other session's audit findings — the ~79 across four punch-list docs (TOP PRIORITY)

### 🔴 1a. The two emergencies — do these BEFORE anything else (live in Phase C.7)
- [ ] **F1** — re-quoting a **won** deal silently swaps the signed contract for an
  in-progress draft (contract, margin, AIA all follow it). Corrupts signed-contract numbers.
- [ ] **F2** — AIA G702/G703 stop footing on any post-seed change order, and
  **already-issued certificates silently restate**. Corrupts payment apps already sent to a GC.

### 1b. The punch-lists (▶ not started)
- [ ] **C.9 — Auto-advance follow-ups** (`AUTOADVANCE_AUDIT_2026_08.md`):
  A2 first (`markProposalOutcome` is a 2nd deal-state writer with no forward-only guard),
  then A1/A3 (`decided_at` restamp + manual-jump stamp), then wire-or-drop `foldAutoAdvanceTargets`.
- [ ] **C.10 — Deal drill-in navigation** (Karan 2026-08-11): keep an item opened from a
  deal tab INSIDE the deal (submittals/proposals/invoices currently break out to standalone
  pages). Treat as a class — sweep change-orders, AIA, costs, work-order, closeout, debrief too.
- [ ] **C.7 — Flow + logic (11 items)** (`FLOW_LOGIC_PUNCHLIST_2026_08.md`): F1/F2 above first,
  then F3 (decided_at), F4 (no-bid reclassified), F5 (void→draft keeps a payment),
  F6 (AIA original-contract ignored), F7–F10 (drag-to-Proposal revert, Start-Project maze,
  lost-flip leaves the account, due-date TZ off by a day).
- [ ] **C.6 — Completeness (20 gaps)** (`COMPLETENESS_PUNCHLIST_2026_08.md`): money/dispatch first
  (C2 void hard-deletes CO billing · C3 tax-exempt skipped on CO path · C4 delete-confirm
  understates cascade · C5 deactivated employee still scheduled), then the ~9 mutations that
  swallow their failure Result (C7–C10), then C1 (proposal PDF hardcoded footer → thread
  `getOperatingCompany`).
- [ ] **C.8 — Re-audit remainder, R7–R23** (`REAUDIT_SHIPPED_2026_08.md`): R1 first — flip
  `dealMargin()` to billed-based (built contract-based, opposite of decision D2; auto-fixes
  R2/R12/R17/R21/R22), then R3 (Closed-column flood-guard), R4 (crew welcome-email <10min
  suppression), R5/R6 crew scope, then R7–R16 half-solves.
- [ ] **C.5 — Consistency (27 items)** (`CONSISTENCY_PUNCHLIST_2026_08.md`): surgical batch
  (H3, M1, M4–M6, L2–L9) now; five items (H1/H2/H4/H6/M7) gated on Karan's D1–D5 answers.

---

## 2. Full re-audit — Phase D
- [ ] Fresh persona + adversarial agents over everything from A–C. Non-negotiable: this round's
  audits caught a live security leak and two bugs in code written minutes earlier.

---

## 3. Proposal-editor regression items — pending Karan's regression lens
- [x] AddLineItemForm ?back= drop (ejected from Proposals queue) — fixed.
- [x] Four hand-built redirects → `proposalHref` (carry back) — fixed.
- [x] new-revision failure landing on a shim that discarded the error — fixed.
- [x] Dead `?saved=1` banner (autosave is revalidate-only) — removed.
- [ ] **The five never-firing banners** — only `saved` confirmed + removed so far; the other four
  aren't identifiable from the editor's own params (approval×5, outcome×4, sent, created, kept,
  error all have matching set-redirects). **HOLD** for the regression lens (auditing the last
  20 commits) to pin them, then fix.

---

## 4. Endgame — road to done (Karan-confirmed order)
- [ ] Reports suite — **once Katie says which** (blocked on Katie).
- [ ] RFP email → auto-populate the opportunity — Karan walks the parsing rules with Claude,
  not spec'd blind.
- [ ] **STOP → joint smoke test with Karan → DONE.**
- ~~Stephanie's list~~ — **DONE (other session).**
- *(Parked: Foreman Daily Log — "we don't need it for now".)*

---

## 5. One pending confirmation (Karan, 30 seconds)
- [ ] **Migration 137 (storage RLS)** — upload a file on Documents or a Work Order. Success =
  healthy. Can't be verified via the service-role path.

---

## Still blocked on people (not buildable)
Reports → **Katie** · Letter of Transmittal specifics → **Stephanie/Brendan** · first+last-name
sign-off screen → **Brendan** · Katie #3 / #8 / F2 → **Katie** · Proposal page order → **Stephanie**.
