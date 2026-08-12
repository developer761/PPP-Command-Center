# Commercial CC — MASTER PLAN (2026-08)

**One document. Two Claude sessions were producing overlapping plans; this is the
single source of truth for what's left, who does it, and in what order.**

Supersedes the running order in `COMMERCIAL_MEETING_PLAN_2026_08.md` and the
"what's left" sections of the two build specs. Those specs remain authoritative
for *how* to build their feature — this file owns *what* and *when*.

---

## 0. Who does what

| Session | Role |
|---|---|
| **Build session** | Writes the code. Owns every file change below. |
| **Verification session** | Writes build specs, runs persona/adversarial audits, re-checks shipped work. Does **not** build. |

Both specs (`CREW_ROLE_BUILD_SPEC_2026_08.md`, `OVERVIEW_AUTOADVANCE_CLOSED_BUILD_SPEC_2026_08.md`)
were written by the verification session **for** the build session. Their edge
rules came from adversarial workflows run against real code — treat them as
requirements, not suggestions.

### The one collision surface
`app/commercial/accounts/[id]/page.tsx` — the deal drill-in. The Crew build
doesn't touch it; the Overview build owns it. **Serialized below so they can
never be in flight together.**

---

## 1. Build order

### ▶ PHASE A — Crew role *(spec: CREW_ROLE_BUILD_SPEC)*
Security is already correct (deny-by-default allowlist, no leak). The *feature*
is broken: 3 of 4 tiles bounce, the full 25-link sidebar renders.

- Auth resolves by the explicit `user_id` link **only** — never email
  auto-match. Email may pre-select the admin's picker; it must not resolve
  identity. (A nullable/mismatched/duplicate address silently attaches one
  person's hours and schedule to another — the exact leak this role guards.)
- **PIN required on personal login** (Karan's call). PIN is the *punch*
  credential, not an identity check: same action on phone or shop tablet.
- Scoped `My Schedule` / `My Hours` / `My Jobs`; crew-aware chrome; trimmed
  allowlist; unlinked crew get the "ask an admin to link you" empty state.
- **Do not touch** the company-wide `/commercial/field-ops/{schedule,calendar,hours}` —
  they stay admin-only.

Migration 125 already applied.

### ▶ PHASE B — Overview phase-swap + Closed column *(spec: OVERVIEW_… §2 stageRank · §3 Overview · §5 Closed column)*
Display work, no status engine. Lands the deal-Overview KPI swap (a pre-sale bid
currently shows the delivery Profitability block with $0 across it) and the
visible Closed column.

Doing B before C on purpose: it's the same page as C's notifications but carries
none of C's status-write risk, so a mistake here is visible, not silent.

### ▶ PHASE C — Auto-advance engine *(spec: OVERVIEW_… §4 auto-advance)*
The riskiest item — it writes statuses. Requires the shared
`stageRank(status, sub)` helper used by **all three** call paths (live proposal
cascade, page-load reconciler, new auto-advance), forward-only, terminal
no-ops, manual-wins, one atomic write + one notification per change.

Also fixes a **live** bug: the reconciler is bidirectional today, so advancing a
deal and then opening an R2 draft yanks it back to Estimating. Making it
forward-only ends that ping-pong.

### ▶ PHASE C.5 — Consistency punch-list *(doc: CONSISTENCY_PUNCHLIST_2026_08.md)*
27 verified cross-surface inconsistencies from a 6-dimension consistency sweep —
same metric showing two numbers (win rate, margin, "Invoiced" pre-tax vs
with-tax), a "needs debrief" badge that can't reach zero, one deal naming
different stages on different surfaces, proposal IDs outside the shared family,
and confusing empty-states/flow. **Surgical items (H3, M1, M4–M6, L2–L9) batch
immediately**; five items (H1/H2/H4/H6/M7) gate on Karan's D1–D5 answers in that
doc. Do the surgical batch alongside B/C; the gated ones after Karan answers.

### ▶ PHASE C.6 — Completeness punch-list *(doc: COMPLETENESS_PUNCHLIST_2026_08.md)*
20 verified "should've-been-caught" gaps — plumbing built but unwired, silent
actions, outputs missing context. Do the **money/dispatch** ones first (C2 void
hard-deletes CO billing; C3 tax-exempt skipped on CO path; C4 deal-delete
confirm understates cascade; C5 deactivated employee still scheduled), then the
one mechanical batch (C7–C10: ~9 mutations swallow their failure Result), then
the rest. C1 (proposal PDF hardcoded footer) is high — thread getOperatingCompany.

### ▶ PHASE C.7 — Flow + logic punch-list *(doc: FLOW_LOGIC_PUNCHLIST_2026_08.md)*
11 verified broken-flow / wrong-logic items. **F1 + F2 first, above everything**:
re-quoting a WON deal silently swaps the signed contract for an in-progress
draft (contract/margin/AIA all follow it), and AIA G702/G703 stop footing on any
post-seed change order while issued certificates silently restate. Then the
other money ones (F3 decided_at, F4 no-bid reclassified, F5 void→draft keeps a
payment, F6 AIA original-contract ignored), then the flow breaks (F7 drag-to-
Proposal reverts — ties to auto-advance; F8 Start-Project maze; F9 lost-flip
leaves the account; F10 due-date TZ off by a day).

### ▶ PHASE C.8 — Re-audit of the shipped batch *(doc: REAUDIT_SHIPPED_2026_08.md)*
Side-by-side re-audit of the batch that cleared C.5/§3/§5 items. Structure is
mostly good but details regressed — **fix before the auto-advance handoff**.
**R1 first: the margin fix was built CONTRACT-based, the opposite of decision
D2** (the commit comment overrode the decision) — flip `dealMargin()` to billed;
it auto-fixes R2/R12/R17/R21/R22. Then **R3** (Closed column now floods a
fully-closed account's board — the §5 flood-guard wasn't applied) and **R4** (the
crew welcome-email `<10min` suppression makes a same-minute new hire get no
schedule/scope email + no clock nudge). Then R5/R6 crew scope (1-of-4 email paths;
alternates folded in) and the R7–R16 half-solves.

### ▶ PHASE D — Full re-audit
Fresh persona + adversarial agents over everything from A–C. Non-negotiable:
this round's audits caught a live security leak and two bugs in code written
minutes earlier.

### ▶ PHASE E — Stephanie's list + Karan's three items
Starts only when D is clean.

---

## 2. Everything else, with status

### Blocked on people — not buildable
| # | Item | Waiting on |
|---|---|---|
| 1 | Reports suite — which reports | **Katie** |
| 2 | Submittals page feedback | **Stephanie** |
| 3 | Letter of Transmittal final specifics + remove COI + signature | **Stephanie / Brendan** |
| 4 | The "first + last name" sign-off screen | **Brendan** |
| 5 | Katie #3 (typo — which screen) · #8 (the $8k proposal) · F2 (send submittals from the CC?) | **Katie** |
| 6 | Proposal page order | **Stephanie** |

⏰ Reminder set for **2026-08-12, 12pm EST** covering 4, 5, 6.

### Deferred by decision
- **Google Drive / Dropbox archive + restore** of project doc drawers — Katie flagged as future, low priority.
- **Scheduling & labor module** — the big one, deliberately last.
- **RFP email → auto-populate the opportunity** — the endgame bonus. After it:
  **STOP and do a joint smoke test with Karan** before calling the platform done.

### Needs verification, not building
- **Tap-to-sign breadth** — the stored signature is used in the closeout PDF;
  confirm it also flows into warranty, LoT, contracts and approval sign-offs.

### Verified DONE — do not rebuild
Change-orders itemised on invoices · AIA templated Excel with the Tomco
operating-company label · invoice-create under the deal · AR / open-invoice
statement · lien-waiver **storage** (upload, never generate) · proposal
internal-vs-client split (bid notes, marked-up doc, per-line show-price,
adjustable final price, Bid Set date, Kim = estimator) · Kim→Brendan approval
loop · project rollups · WO-from-proposal builder + multiple sheets + unassigned
indicator · operating-company config · pre/post-contract deal **tabs** ·
notifications preset + custom · the six pre-contract stages + post-contract
Status→Sub-status · shared record IDs (OPP/PROP/PROJ/WO/TRANS) · Teams (incl.
role expansion) · new-opportunity form parity + slim form + repeat prefill ·
all 9 findings from the 2026-08 persona audit.

---

## 3. Standing rules (both sessions)

- Build to the spec's edge rules — they came from adversarial passes against
  real code, not from taste.
- `tsc` + full test suite + production build green **before every commit**.
- Never mark an item done without checking the actual query/render, not the
  commit message. Two "verified" claims this round turned out to be false.
- Migrations: add the file to `supabase/migrations/` even when the DDL was
  applied by hand, or a fresh environment breaks with an error that reads like
  a code bug.
