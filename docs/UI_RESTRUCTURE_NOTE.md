# UI restructure — note from the verification session (2026-08-12)

Karan says the **UI is being restructured**. This is the verification session
opening the conversation: (1) what I need from you to recheck it, and (2) the
guardrails everything audited so far says a UI restructure must not break. Reply
by committing your plan (see §1) and I'll audit it against §2/§3 before and after.

## 1. First — commit your restructure PLAN so I can recheck it
I can't see your working tree; only pushed `main`. Please commit a short
`docs/UI_RESTRUCTURE_PLAN.md` (or push a branch + tell me the name) with:
- **What's changing** — which surfaces (dashboard, account, deal drill-in,
  pipeline board, proposals, invoices, field-ops), and the new structure.
- **What's staying** — so I know a missing thing is intentional, not dropped.
- **Migration/route changes** — any URL/param changes (they break bookmarks +
  the `?back=`/`&sid=`/`&inv=` drill-in wiring we just built).
Then I'll do a before-audit (does the plan preserve §2/§3) and an after-audit
(did the code match), same loop as the punch-lists.

## 2. HARD guardrails — a UI restructure must NOT regress these (all verified this week)
- **Everything under the deal (F12).** Submittal detail, invoice detail, and
  proposal editor now open INSIDE the deal drill-in (`?tab=projects&project=…&dt=…`
  + `&sid=`/`&inv=`, `DRILL_IN_RE`-guarded back). Chips point in-deal. Do not
  send any deal sub-item back out to a standalone page.
- **Phase-aware overview (3-way).** The deal Overview swaps KPI sets by
  `dealPhase`: **lost → outcome card; won-not-started → navy "ready to start" +
  one-click Start Project; in-delivery → billed-based money tiles; pre-sale →
  sales tiles ("—/Not priced yet", never $0)**. Keep the swap; don't collapse it
  back to one set.
- **Money display is billed-based (D2).** Margin everywhere = `marginFrom(billedPreTaxCents, cost)`;
  AR = `openBalanceCents`; %billed = `billedPreTaxCents/contract`; contract-based
  only as a labeled "vs budget" line. A restructure must reuse these, not
  recompute a second definition.
- **One id / one label / one tone.** Proposal id = `proposalDisplayId` (PROP-2026-####)
  everywhere; status color = `statusPillTone(status, sub)` (one helper); status
  label = `oppStatusDisplayLabel`. Don't reintroduce a parallel map.
- **Deploy gate.** Migrations 126–130 are applied; keep using the columns
  (`status_user_set_at`, `closed_out_at`, `accepted_contract_cents`, frozen AIA
  cols, `original_contract_is_manual`) — don't strip the reads/writes.

## 3. Katie's UI bar — build the restructure TO this (not "good enough")
- **Mobile-perfect**: 44px targets, works at 360–390px, no iOS zoom on inputs,
  the important number/status above the fold (the post-sale strip is 7–8 tiles —
  prioritize Contract · Billed% · AR · GM% on mobile).
- **One-click / autofill**; **searchable dropdowns > ~10 items** (one reusable
  combobox); progressive disclosure over clutter; skeletons over spinners.
- **Empty states read like a person wrote them**; no `$0`/`NaN`/gray-ring "is
  this broken?" states (guard divide-by-zero, provisional → neutral tone).
- **Flow**: every action lands you back where you were (tab/scroll/drawer
  preserved); back-arrows/breadcrumbs consistent; no dead ends.

## 4. Offer
Tell me (via the plan doc) the ~5–8 surfaces in scope and I'll:
- run a persona/adversarial pre-audit of the new layout (CEO-mobile, office,
  rep, PM) for flow + mobile breaks BEFORE you build, and
- re-audit each surface after, against §2/§3.
Same cadence that's been catching the 90%s. Let's not regress the drill-in +
money work while moving the furniture.
