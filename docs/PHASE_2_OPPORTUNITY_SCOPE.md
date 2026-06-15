# Phase 2 — Opportunity Pipeline · Scope (locked 2026-06-15)

Phase 1 (Accounts) is shipped + audited clean. This doc locks the
answers to the 5 open questions Karan + Claude agreed on before
Batch 0, so build agents can reference one source of truth.

## 1. Status DAG

9 statuses, intentionally minimal. Reduces ramp + every status
maps to a clear next-action.

```
inquiry  ────► site_visit_scheduled  ────► site_visit_done
                                       │
                                       └──► no_bid
                                       └──► on_hold ◄──┐
site_visit_done ──► estimating ──► proposal_sent      │
                                  │                   │
estimating ──► on_hold ◄──────────┴─► negotiating     │
                                          │           │
                                          ├──► won    │
                                          ├──► lost   │
                                          └──► on_hold┘
on_hold ──► estimating  (reversible — re-engage stalled deal)
won ──► reopened (rare; audit-logged via status_log)
```

Default probability_pct per status (overridable per-row):
- inquiry: 10
- site_visit_scheduled: 20
- site_visit_done: 35
- estimating: 50
- proposal_sent: 60
- negotiating: 75
- won: 100
- lost / no_bid: 0
- on_hold: keep prior value

## 2. Bid value

- `bid_value_low_cents BIGINT NULL`
- `bid_value_high_cents BIGINT NULL`
- Allowed: both NULL (early inquiry), low=high (firm number),
  low<high (range).
- CHECK: `bid_value_low_cents IS NULL OR bid_value_high_cents IS NULL OR bid_value_low_cents <= bid_value_high_cents`
- Lib auto-swaps if a user submits high < low (don't reject).
- UI works in dollars; DB stores cents to dodge float rounding.

## 3. Currency

USD only for v1. No `currency` column shipped — adding it later as
nullable + default 'USD' is a 1-line migration if PPP ever crosses
state lines.

## 4. Hot deal threshold

Default: bid_value_high_cents >= 5_000_000 (= $50k) AND
proposal_due_at <= now + 14 days AND status IN (estimating,
proposal_sent, negotiating).

Threshold values live as constants in `lib/commercial/opportunities/
constants.ts` for now; promote to `commercial_settings` table when
Alex starts asking to tune them.

## 5. Delete semantics

Soft-delete via `deleted_at` (mirror Phase 1 accounts).
- Lost / no_bid are STATUS values, NOT deletion. Opps stay queryable
  forever for win/loss reporting.
- `deleted_at` only flips when Alex says "I made this by mistake."
- Soft-deleted opps drop out of all list/Kanban/Account-tab queries.
- The detail page 404s once soft-deleted (no edit path).

## Other locked decisions

- **Primary contact auto-populates** from
  `commercial_account_contacts` where `is_primary = TRUE` on the
  account at opp create time. User can override per-opp.
- **Multi-team-per-opp** via separate
  `commercial_opportunity_assignments` table mirroring the account
  team pattern (partial UNIQUE on `(opp_id, role) WHERE is_primary`).
- **Plans & Specs**: separate Supabase Storage bucket
  `commercial-opportunity-files`. Same upload/signed-URL pattern as
  account docs. No category enum — these are arbitrary files
  (RFP.pdf, plans_set_A.pdf, spec_book.pdf, proposal_v2.pdf).
- **Tasks**: `(opp_id, title, due_at, assigned_user_id, completed_at,
  completed_by_user_id)`. Notification bell pings the assignee 24h
  before due.
- **Status change** is its own server action that writes to
  `commercial_opportunity_status_log` AND updates the opp row in
  one round-trip. Lost reason required when `to_status = 'lost'`.
- **Account-detail integration ships in Batch 5**, NOT Batch 1.
  Build the standalone Opp surface first; weave in last so the
  Account tab can show a non-empty real view.

## Batch sequence (locked)

- Batch 0: pre-audit + scope migration 028 + scaffold
- Batch 1: migration 028 + opps list + new + detail shell
- Batch 2: status DAG + status_log + lost reason picker
- Batch 3: team + tasks + notes (migrations 029, 030)
- Batch 4: plans & specs attachments + Storage bucket (migration 031)
- Batch 5: account-side Opportunities tab + Account 360 view
  extension (migration 032 — append-only)
- Batch 6: pipeline summary + hot/stale filters + CSV export
- Batch 7: mobile pass + 6-agent wide audit + fix loop
