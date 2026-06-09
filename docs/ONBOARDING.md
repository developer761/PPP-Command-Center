# Onboarding — your first day

You've just joined PPP and have access to this repo. This doc is your **read-in-order checklist** so you're not staring at a 2,000-line file wondering where to start.

Total time to onboard: **~2-3 hours** if you read the suggested files end-to-end. After that you should be able to make non-trivial changes.

---

## 1. Get the dev environment running (15 min)

```bash
git clone git@github.com:developer761/PPP-Command-Center.git
cd PPP-Command-Center
npm install
cp .env.example .env.local   # ask Karan for the actual values
npm run dev
```

Open `http://localhost:3000`. If Salesforce credentials aren't set yet, you'll see the dashboard rendered against mock data — that's fine for now, you can explore the UI.

Useful commands:
- `npm run dev` — Next.js 16 + Turbopack
- `npm run build` — production build (MUST pass before any PR merges)
- `npx tsc --noEmit` — type check
- `npm run lint` — ESLint

---

## 2. Read these docs in order (45 min)

| # | File | Why |
|---|---|---|
| 1 | [`README.md`](../README.md) | Product overview, tech stack, folder map, critical conventions, common gotchas. Skim. |
| 2 | [`AGENTS.md`](../AGENTS.md) | Next.js 16-specific gotchas (this isn't the Next.js you know — APIs have changed). |
| 3 | [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) | The deep one. Why Salesforce is the source of truth, how the snapshot cache works, the customer form deep-dive, the supplier order builder, auth model. **Re-read sections as you hit them in code.** |
| 4 | This file | The reading order itself |

---

## 3. Read these files in order (90 min)

Each file has a header comment explaining what it does. Read top-to-bottom; don't skip the header.

### The data layer (45 min)

| # | File | What you'll learn |
|---|---|---|
| 1 | [`lib/data-source.ts`](../lib/data-source.ts) | The single entry point every dashboard page uses. Wraps viewer resolution + snapshot loading + scoping. **Start here.** |
| 2 | [`lib/salesforce/queries.ts`](../lib/salesforce/queries.ts) | The cached SF snapshot — top 200 lines explain the pattern; the rest is per-entity query construction. Skim the per-entity sections, then dive into `loadSalesforceSnapshot` itself. |
| 3 | [`lib/salesforce/derive.ts`](../lib/salesforce/derive.ts) | Pure functions that turn a snapshot into UI-ready shapes (top rep, period delta, financials, etc.). Read the file's header + the first 3-4 derives. The pattern is consistent across all 20+. |
| 4 | [`lib/salesforce/derive-cache.ts`](../lib/salesforce/derive-cache.ts) | The `memoBySnapshot` helper — 50 lines. WeakMap-keyed per-snapshot memoization. Why: a single page render calls many derives, sometimes multiple times. |
| 5 | [`lib/auth/scope-snapshot.ts`](../lib/auth/scope-snapshot.ts) | How admin vs worker views diverge. Worker only sees their own opps/WOs/accounts. |

### The customer form (30 min)

| # | File | What you'll learn |
|---|---|---|
| 1 | [`lib/customer-form/tokens.ts`](../lib/customer-form/tokens.ts) | Token lifecycle (create / send / open / submit). 200 lines. |
| 2 | [`lib/customer-form/render-data.ts`](../lib/customer-form/render-data.ts) | Live-from-SF fetch of one WO's form context. NOT cached (and the header explains why). |
| 3 | [`lib/customer-form/material-types.ts`](../lib/customer-form/material-types.ts) | The ~100-product catalog + interior/exterior filter routing. **Single source of truth** for paint products. |
| 4 | [`app/api/customer-form/submit/[token]/route.ts`](../app/api/customer-form/submit/[token]/route.ts) | The submit endpoint — drift detection, validation, writeback. Read end-to-end. |
| 5 | [`components/customer-form-view.tsx`](../components/customer-form-view.tsx) | The form UI itself. Big (~1,350 lines) but the header has a section-by-section guide. |

### The supplier order (30 min)

| # | File | What you'll learn |
|---|---|---|
| 1 | [`lib/supplier-order/estimate-gallons.ts`](../lib/supplier-order/estimate-gallons.ts) | The gallon math — coverage config + surface estimation. Pure math, easy to test. |
| 2 | [`lib/supplier-order/builder.ts`](../lib/supplier-order/builder.ts) | The big one (~1,200 lines). Pure function — composes a WO + supplier + customer payload into an email-ready draft. Read the header + scan the named sections. |
| 3 | [`app/api/admin/supplier-order/draft/route.ts`](../app/api/admin/supplier-order/draft/route.ts) | The draft endpoint — calls the builder, persists the draft. |
| 4 | [`app/api/admin/supplier-order/send/route.ts`](../app/api/admin/supplier-order/send/route.ts) | The send endpoint — PO number generation (collision-safe), Resend send, audit log. |

---

## 4. Make your first change (the "no fear" exercise)

Pick the smallest possible thing — change a label or tweak a copy string. Suggested first PRs:

- Find a `text-ppp-charcoal-500` style somewhere subtle, swap to `text-ppp-charcoal-600`. PR it.
- Add a comment to a function in `lib/salesforce/derive.ts` that you wish was there when you read it.
- Find a TODO somewhere via `grep -r TODO lib/ app/ components/`. Triage it (close it, or expand it, or fix it).

The goal isn't the change — it's seeing the build pipeline, the lint, the PR review, and the deploy to Vercel. Once you've done one, the rest are easy.

---

## 5. Conventions you'll be bitten by if you don't internalize

### Salesforce is the source of truth
- Read SF live (with the 30-min cache layer).
- Write back to SF for finalized data only (color picks, material type, vendor orders).
- **Never mirror SF data into Supabase.** Supabase holds workflow state only.

### snake_case columns, camelCase TypeScript
- Supabase columns: `work_order_id`, `submitted_at`, `customer_email`.
- TypeScript types use the column name as-is for DB-shaped types (`TokenRow`).
- Once data crosses into derive/UI land, you can rename to camelCase (`workOrderId`, `submittedAt`).
- Conversion happens at the boundary, not in random spots in the middle.

### Server-only files
- Any file using the Supabase service-role key starts with `import "server-only";`.
- This file CANNOT be imported by a client component — Next.js will error at build time.
- The boundary is enforced; trust it.

### `kind='preview'` filter
- The "Preview" button on the JobDetail panel creates a real token row with `kind='preview'`.
- **Five surfaces filter this out** so admin QA clicks don't pollute customer-activity metrics. See `docs/ARCHITECTURE.md` → "Preview vs real send — DO NOT BREAK THIS".
- If you add a new surface that reads `customer_form_tokens`, you MUST filter `kind='preview'`.

### Migrations are paste-in
- SQL files in `supabase/migrations/*.sql` get pasted into the Supabase SQL editor by hand.
- Every migration must be `IF NOT EXISTS` / `ON CONFLICT`-safe so re-runs are no-ops.
- The app must tolerate the migration being un-applied — e.g., `createToken` falls back to a narrower INSERT if the `kind` column isn't there yet.

### `force-dynamic` on dashboard pages
- Every authenticated dashboard page sets `export const dynamic = "force-dynamic";`.
- This forces server-side rendering on every request. The snapshot cache + memoization is what makes this fast.
- DO NOT remove this — static caching at the page layer would break viewer scoping (admin would see a worker's cached page).

### Cron config lives in the Vercel UI, not in this repo
- The repo has NO `vercel.json`. Cron jobs are configured in Vercel Project Settings → Cron Jobs.
- The snapshot pre-warm fires at `/api/cron/snapshot-warm` every 10 minutes.

---

## 6. Who to ask when you're stuck

- **Karan Malhotra** (lead dev) — bkflowconsulting@gmail.com / 347-476-6555
- **Katie** (PPP project owner) — for product/business questions
- **Alex** (PPP exec) — for strategic / ops questions

When you're stuck on a code question, before you ask:
1. Check `git log` on the file — the commit messages here are extended bodies with the "why," not just the "what."
2. Search `docs/ARCHITECTURE.md` for the topic.
3. `grep -r` the function name to see who calls it.
4. THEN ask.

---

## 7. Done — what next?

- Pick an issue from the project tracker or shadow Karan for a day.
- Read `docs/PHASE_2_PLAN.md` if you're working on materials ordering.
- Read `docs/PAINT_CALCULATOR_PLAN.md` if you're touching the gallon math.
- Welcome aboard.
