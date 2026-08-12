# Note to the build session — from the verification session (2026-08-12)

Karan's directives for the rest of this run. Read before the next batch.

## 1. The migration-guard class is SYSTEMIC — fix it once, now (not optional)
Five migrations in a row (126→130) shipped with an unguarded write/explicit-read
that breaks a real flow on a pre-migration deploy: R25 (first manual status
change rejected), R30, R31 (can't issue an AIA app), R33 (win/close-out
rejected), R35 (can't edit AIA contract). The *fixes* are all correct — only the
deploy-order safety keeps repeating.

**Do the one-time systemic fix before shipping another new-column migration.**
Katie-aligned choice (see §4): **wrap the two hot write paths in the
`isMissingColumn` retry you already wrote** (`projects/accepted-contract.ts:95`) —
- `lib/commercial/opportunities/status.ts` UPDATE (covers 126 `status_user_set_at`
  + 129 `closed_out_at`),
- `lib/commercial/aia/db.ts` update (covers 130 `original_contract_is_manual`;
  make the two explicit `.select("… frozen/manual …")` reads degrade too).
A manual "apply the migrations first" checklist is the fallback, not the fix —
a deploy must NEVER break a user's status change or AIA submit. This is a
data/uptime class, not cleanup.

## 2. No 90% — complete each item's whole class, then verify against the code
The recurring miss all round has been the same shape: a fix lands on the obvious
surfaces and misses a sibling. The margin sweep skipped reports (R24). The F12
proposal editor carried the origin through the 13 approval actions but **dropped
it on the line-item + rename actions (R32) — the exact scenario its own commit
said it fixed.** Before marking an R#/F# done: grep for every sibling call site
and confirm none was missed. **Finish R32** (thread `proposalBack` through
`renameProposalAction`/`addLineItemAction`/`updateLineItemAction` and have those
forms emit the `back` field).

## 3. Complete to Katie's bar — do not defer
Katie's standing bar: everything for a deal lives **under that deal** (F12 is
this); **mobile-perfect** (44px, works at 375px); **one-click / autofill**;
**searchable dropdowns > ~10 items**; **no "good enough."** The ONLY sanctioned
deferral is the foreman **Daily Log → build last** (Karan's call). Everything else
on the punch-lists gets finished, not parked. If you find yourself writing
"for now / later / TODO", stop and complete it.

## 4. When choosing between two options, choose Katie's — pre-resolved calls
- **Deploy safety** → the code-guard (§1), not a checklist. Katie's users can't
  hit a broken flow because a migration lagged.
- **Historical repairs** (the new screen) → before applying a computed repair to
  a signed-document row, verify the per-case math against a couple of real rows.
  A wrong repair is indistinguishable from the bug it fixes — Katie would not
  bulk-apply money changes to signed docs unchecked.
- **Any UI either/or** → the option that (a) keeps it under the deal, (b) is
  mobile-perfect, (c) takes the fewest clicks. When those conflict, under-the-deal
  wins (Katie's #1 IA rule).
- **"Ship the simple version now, richer later"** → build the richer version now
  if Katie would use it (anticipate + build right the first time). Only genuinely
  last-phase items (Daily Log, scheduling module, RFP-email parse) wait.

## 5. Remaining punch-list (all committed docs)
Money/flow: **R32** (finish F12 proposal editor), R26/R27/R28. Consistency C.5
(H1 win-rate, H4 debrief, H6 proposal-IDs, M7 open-a-deal + the surgical batch).
Completeness C.6 (C1 proposal PDF footer, C7–C10 silent-action batch, etc.).
Everything blocked-on-people (Reports/Submittals/LoT) stays blocked — don't guess.

The verification session is re-auditing every batch against the code and will
keep logging findings to `REAUDIT_SHIPPED_2026_08.md`. Pull it each round.
