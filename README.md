# PPP Command Center

Internal operations platform for **Precision Painting Plus** (Long Island
paint contractor). Layers workflow + analytics on top of Salesforce — SF stays
the system of record; this app handles the day-to-day work that doesn't
belong in SF (customer color forms, supplier order emails, mail history,
admin diagnostics).

**Production:** `hub.precisionpaintingplus.net` (Vercel)
**Repo:** `github.com/developer761/PPP-Command-Center` (private)

---

## Quickstart

```bash
npm install
npm run dev       # http://localhost:3000 — Next.js 16 + Turbopack
npm run build     # production build (must pass before deploy)
npm run lint      # ESLint (warnings allowed in scripts/, not in app/lib/components)
npx tsc --noEmit  # type check
```

You'll need `.env.local` with Supabase + Salesforce + Resend keys. Ask Karan
for the values — they're not in the repo.

---

## Tech stack

- **Next.js 16** (App Router) + React 19 + TypeScript + Tailwind 4
- **Salesforce** via `jsforce` — source of truth for customers, work orders, line items
- **Supabase Postgres** — workflow state (drafts, sent emails, audit logs). **NOT a SF mirror.**
- **Resend** — outbound emails (color form invites, supplier orders, admin notifications)
- **Vercel** — hosting + cron + webhooks
- **No test framework yet** — verified via `tsc`, `lint`, `build`, and manual smoke tests on staging WOs

**Import alias:** `@/...` is the repo root (`tsconfig.json` → `"@/*": ["./*"]`).
You'll see `@/lib/salesforce/queries`, `@/components/materials-view`, `@/app/api/...` everywhere — that's the alias, not a node-module package.

**New here?** Read [`docs/ONBOARDING.md`](./docs/ONBOARDING.md) — it lays out the files to read in order to get productive in ~2-3 hours.

---

## What it does (end-to-end)

```
                  ┌─────────────────────────────────────────┐
                  │  Salesforce (system of record)          │
                  │  WorkOrder + WOLI + Account + Vendor    │
                  └─────────────────┬───────────────────────┘
                                    │ jsforce + 15-30 min cache
                                    ▼
   ┌────────────────────────────────────────────────────────┐
   │  Command Center (this app)                             │
   │                                                        │
   │  Admin Materials view ──┐                              │
   │                         ├──► Send Color Form ─────┐    │
   │                         │    (token-gated link)   │    │
   │                         │                         ▼    │
   │                         │      Customer picks colors   │
   │                         │      + Material Type +       │
   │                         │      notes for sparse WOs    │
   │                         │                         │    │
   │                         │   ◄─────────────────────┘    │
   │                         │      Submit (writeback to SF │
   │                         │       — gated test_only/all  │
   │                         │       /off, allowlist)       │
   │                         │                              │
   │                         └──► Order materials ─────┐    │
   │                              (pick store +        │    │
   │                              compose email)       │    │
   │                                                   ▼    │
   │                                          Supplier email │
   │                                          (Resend)       │
   │                                                   │    │
   │   Mail Hub ◄──────────────────────────────────────┘    │
   │   (inbox + sent + delivery status webhooks)            │
   └────────────────────────────────────────────────────────┘
```

---

## Folder map (the parts you'll actually touch)

```
app/
├── dashboard/
│   ├── materials/page.tsx        # the materials ordering surface (THE hot page)
│   ├── inbox/page.tsx            # Mail Hub
│   ├── customer/[accountId]/     # per-customer history
│   ├── rep/[id]/                 # rep performance dashboards
│   └── settings/                 # health checks, suppliers, templates, coverage
├── select/[token]/page.tsx       # customer-facing color form (NO auth — token-gated)
└── api/
    ├── admin/                    # admin-only routes (require Supabase auth + is_admin)
    │   ├── customer-form/        # create/preview/wo-email-lookup
    │   ├── supplier-order/       # draft/send
    │   ├── sent/                 # Mail Hub data + resend bounced
    │   └── activity/             # recent activity feed
    ├── customer-form/submit/[token]/  # public submit endpoint (token-gated)
    └── webhooks/
        ├── resend-events/        # delivery, bounce, open, click
        └── resend-inbound/       # supplier replies → Mail Hub

components/
├── materials-view.tsx            # THE big one (~2k lines): WO list + JobDetail
├── customer-form-view.tsx        # the color form UI (customer-facing)
├── supplier-order-modal.tsx      # the order-from-vendor modal
├── material-type-picker.tsx      # categorized + searchable + collapsible MT picker
└── draft-order-modal.tsx         # read-only color preview (lazy-loaded)

lib/
├── salesforce/
│   ├── queries.ts                # loadSalesforceSnapshot — the cached SF data layer
│   └── materials.ts              # derive open WOs / line items / suppliers from snapshot
├── customer-form/
│   ├── render-data.ts            # what the customer form needs (cached 3min per-instance)
│   ├── material-types.ts         # the MT catalog + interior/exterior filter logic
│   ├── tokens.ts                 # create/validate/markOpened/markSubmitted
│   ├── wo-status.ts              # form status per-WO (sent/opened/submitted/expired)
│   ├── writeback-mode.ts         # the test_only / all / off gate for SF writes
│   └── notify-sender.ts          # admin notification email on submit
├── supplier-order/
│   ├── builder.ts                # composes the supplier email body + draft state
│   ├── coverage-config.ts        # tunable gallon estimates (Settings → Coverage)
│   └── estimate-gallons.ts       # the gallon math
├── wo-progress/derive.ts         # the 5-stage timeline (Form Sent → Job Done)
├── materials-page-data.ts        # consolidated loader for the materials page
└── data-source.ts                # loadDashboardData wrapper (handles thin mode)

supabase/migrations/              # SQL migrations — apply by hand via Supabase SQL editor
scripts/                          # one-off SF schema probes + debug tools
docs/                             # architectural deep-dives (PHASE_2_PLAN.md, etc.)
```

---

## Critical conventions

### 1. Salesforce is the source of truth

- Read SF live (with 30-min cache) for customers, work orders, line items.
- Write back to SF for finalized data (color picks, material type, vendor orders).
- **Never mirror SF into Supabase.** Supabase holds workflow state only —
  drafts, sent emails, audit logs, internal notes.

### 2. Snapshot cache (`lib/salesforce/queries.ts`)

- `loadSalesforceSnapshot()` fetches the full org snapshot, cached 30 min.
- Two cache keys: `snapshot-v6` (full — used by every dashboard except materials)
  and `snapshot-thin-v1` (materials-only — skips the 89k Opportunity fetch).
- Cross-instance shared cache via Supabase `snapshot_cache` table — invalidated
  by a generation counter that bumps on writeback or manual refresh.
- **Don't add new code paths that call SF directly.** Use the snapshot, or add
  a targeted helper in `lib/salesforce/`.

### 3. Customer form token system

Tokens live in `customer_form_tokens` (Supabase). Two **kinds**:

| `kind` | Created by | Customer impact |
|---|---|---|
| `null` (default) | "Send Color Form" button | Real send. Counts toward all customer-activity surfaces. |
| `'preview'` | "Preview" button | Admin QA. **MUST be filtered out** of progress timeline + form status + activity feed + per-customer mail timeline. |

The preview filter is enforced in 5 places — `lib/materials-page-data.ts`,
`lib/wo-progress/derive.ts`, `lib/customer-form/wo-status.ts`,
`app/api/admin/activity/route.ts`, `app/api/admin/customer/[accountId]/route.ts`.
**If you add a new surface that reads tokens, you MUST filter `kind='preview'`.**

### 4. Writeback safety mode

SF writes during the test phase are gated by `lib/customer-form/writeback-mode.ts`:

- `mode='test_only'` (default) — only WOs in `customer_form_writeback_allowlist` get written back
- `mode='all'` — production rollout, every submission writes back
- `mode='off'` — kill switch

The customer's submission payload is always preserved in Supabase regardless
of the mode, so we can replay later.

### 5. Material Type picker is dynamic by WO

`lib/customer-form/material-types.ts` has the catalog tagged
`interior` / `exterior` / `any`. The picker filters based on the WO's
work-type + line-item product names. Exterior-only products (e.g. Woodluxe)
hide on interior WOs and vice versa. **The catalog is the single source of
truth** — used by the customer form, the admin override dropdown, the
server-side validation, and the supplier email builder.

### 6. Migrations are paste-in

No migration runner. SQL files in `supabase/migrations/*.sql` get pasted into
Supabase SQL editor by hand. Write everything `IF NOT EXISTS` / `ON CONFLICT`
safe so re-runs are no-ops. The app must tolerate the migration being unapplied
(e.g., `createToken` falls back to a narrower INSERT if `kind` column is missing).
See [`supabase/migrations/README.md`](./supabase/migrations/README.md) for the
per-file index and the `011b`/`012b` companion-file naming convention.

### 7. snake_case at the DB boundary, camelCase in TypeScript

Supabase rows arrive snake_case (`work_order_id`, `submitted_at`, `customer_email`).
The conversion to camelCase (`workOrderId`, `submittedAt`, `customerEmail`)
happens at the loader / route boundary — inside `lib/` and `components/`
everything is camelCase. DB-row types (e.g., `TokenRow` in
`lib/customer-form/tokens.ts`) keep the snake_case shape; everything that
crosses into derive/UI land is camelCase. Don't mix the two in the same scope.

---

## Common gotchas

- **`force-dynamic` on every dashboard page** — App Router. Snapshot cache makes this fast.
- **No client-side SF calls.** Everything goes through API routes.
- **Service-role Supabase client** is server-only (`lib/supabase/server.ts`).
  Never import it into a client component.
- **`useMemo` heavily** in `materials-view.tsx` — 100+ WOs render fast because
  derived data is memoized per snapshot identity.
- **PostgREST `.or()` calls collide** — only the last one wins as a single
  filter. If you need multiple OR conditions, filter in code or use `.not()`.

---

## Where to learn more

- `CLAUDE.md` — AI-agent briefing (auto-loaded into Claude Code sessions).
  Has the latest conventions + active engagement context.
- `AGENTS.md` — Next.js 16-specific gotchas + link to the shared SF
  reference repo at `github.com/developer761/ppp-salesforce-reference`.
- `docs/PHASE_2_PLAN.md` — original Phase 2 (materials ordering) plan.
- `docs/PHASE_2_GAME_PLAN.md` — execution playbook.
- `docs/PAINT_CALCULATOR_PLAN.md` — gallon math reference.

---

## Deployments

- Vercel auto-deploys from `main`. Push = ship.
- Cron jobs configured in the Vercel project UI (snapshot pre-warm hits `/api/cron/snapshot-warm`).
- Webhook URLs registered in Resend dashboard (delivery events + inbound).
- Salesforce OAuth refresh token stored in Supabase `sf_credentials` table.

When in doubt, check `git log` for the most recent context — commits are
written with extended bodies explaining the why-not-just-what.
