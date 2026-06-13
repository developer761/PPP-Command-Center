# lib/commercial — New Platform code namespace

This directory holds **all backend code for the New Platform** (commercial
operating system, Phases 0–9 in `docs/NEW_PLATFORM_PLAN.md`).

## Hard separation rule

This namespace MUST NOT import from any of these Command Center modules:

- `lib/salesforce/*` — Command Center's SF-mirror layer
- `lib/auth/scope-snapshot.ts` — Command Center's per-rep WO scoping
- `lib/data-source.ts` — Command Center's `loadDashboardData` (snapshot loader)
- `lib/customer-form/*` — Command Center's residential color-form pipeline
- `lib/supplier-order/*` — Command Center's residential paint-supplier flow

The reverse is also true: Command Center code MUST NOT import from
`lib/commercial/*`. The two layers are parallel.

The only things they share (thin layer at the platform shell):

- `lib/auth/profile.ts` — Supabase user × profile row × access flags
- `lib/auth/admin.ts` — domain allow-list (sign-in gate)
- `lib/notifications/insert.ts` — notification bell helper (kinds are platform-prefixed)
- `lib/supabase/*` — raw Supabase client primitives
- `lib/platform-cookie.ts` — sticky last-platform pref

If you need something that lives outside both lists, copy or rebuild it
under `lib/commercial/`. Do not back-door across the boundary.

## File layout

```
lib/commercial/
├── README.md            ← this file
├── rbac.ts              ← role + project access checks
├── audit-log.ts         ← write helpers for commercial_audit_log
├── db.ts                ← typed Supabase client + table types
├── settings.ts          ← read/write commercial_settings
└── (per-phase folders ship as Phases 1–9 land)
    ├── accounts/        ← Phase 1
    ├── opportunities/   ← Phase 2
    ├── estimates/       ← Phase 3
    ├── contracts/       ← Phase 4
    ├── projects/        ← Phase 5
    ├── execution/       ← Phase 6
    ├── change-orders/   ← Phase 7
    ├── billing/         ← Phase 8
    └── closeout/        ← Phase 9
```

## Database tables

All commercial tables prefix `commercial_*`. Existing as of Phase 0:

- `commercial_user_roles` — per-user role inside the New Platform
- `commercial_audit_log` — every commercial_* write is audited here
- `commercial_settings` — global tunables (fiscal year, retainage default, etc.)

Phase 1 onward will add `commercial_accounts`, `commercial_contacts`,
`commercial_account_documents`, etc. — see plan doc.

## Audit reminder

If you touch a `commercial_*` table directly via Supabase from anywhere
in the codebase, you MUST also write an audit entry via
`writeCommercialAudit()` in `lib/commercial/audit-log.ts`. The audit
trail is a hard requirement (Alex's diagram).
