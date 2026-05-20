@AGENTS.md

# PPP Command Center — Project Context

This file auto-loads on every Claude Code session opened in `~/Desktop/PPP/ppp-command-center`. Source of truth for what the PPP project is, the conventions to follow, and where to find more detail.

> **Important:** PPP is a SEPARATE engagement from BKFlow. The BKFlow SaaS project lives at `~/bkflow-saas`. Do NOT cross-contaminate. The `bkflowconsulting@gmail.com` identity / its MCPs / its Calendar etc. must NEVER be used in PPP work (see [[ppp-never-touch-bkflowconsulting]]).

---

## What this is

**PPP Command Center** — an internal operations platform for **Precision Painting Plus®**, a paint contractor based on Long Island. The platform layers analytics + workflow on top of Salesforce (their existing system of record).

**Client:** Precision Painting Plus · **Primary contact:** Katie · **CEO:** Aaron · **Engagement type:** Fractional AI Ops build (Karan is contractor; Alex is collaborator on roadmap).

**Production URL:** `hub.precisionpaintingplus.net` (DNS CNAME pending PPP IT).

---

## Tech stack

- **Next.js 16 (App Router)** + React 19 + TypeScript + Tailwind 4 + Turbopack
- **Supabase** — workflow state, drafts, audit logs. NOT a SF mirror — SF stays source of truth.
- **Vercel** — hosting (project `ppp-command-center` under developer761 GitHub account)
- **GitHub** — `https://github.com/developer761/PPP-Command-Center` (private)
- **Salesforce** — source of truth for customers, work orders, finalized orders (sandbox access expected 2026-05-20)
- **Anthropic SDK** — supplier-email drafting, receipt extraction, color normalization (Phase 2-3)
- **Resend** — outbound emails to suppliers + customers
- **Future:** Google Workspace SSO for auth (placeholder today)

---

## Critical conventions

### Identity separation

- **NEVER use `bkflowconsulting@gmail.com`** for anything in this project. See `_ppp_is_separate.md` and `feedback_ppp_never_touch_bkflowconsulting.md`.
- Karan's PPP identity: `malhotrak038@gmail.com` (invoice, Zelle, personal).
- PPP-owned operational identity: `developer@precisionpaintingplus.net` (GitHub developer761, Vercel, Supabase, future Google Cloud OAuth project).
- Local git identity for commits: `malhotrak038@gmail.com` (already configured in this repo).

### Salesforce-as-source-of-truth

- Command Center reads SF live (with caching), writes back to SF for finalized data (orders, transactions).
- Do NOT mirror SF data into Supabase. Supabase is for workflow state only (drafts, approvals, audit, internal notes).
- Region/service-line/funnel-stage values from SF must flow through dynamically — no hardcoded lists in the UI. See `project_ppp_salesforce_wiring_edge_cases.md`.

### Mobile-perfect

PPP CEO Aaron looks at this on his phone every morning. Mobile responsiveness is a hard requirement, not an afterthought. See `feedback_ppp_ui_quality_bar.md`.

### Brand alignment

- Official palette + Roboto fonts per the brand-guide deck. See `project_ppp_brand_guide_official.md`.
- Primary: Orange `#EE662E`, Blue `#2BAAE1`, Green `#8DC442`. Secondary: Navy `#172B4D`, Brown, Teal, Light Blue, Pale Green, Warm Beige.
- Font: Roboto (body) + Roboto Condensed (headlines, KPI values, labels).
- Logo + brand assets at `public/brand/`.

### No deferred fixes / no "good enough"

Karan's standing rule. Polish every surface; never ship "good enough." See `feedback_ppp_ui_quality_bar.md`.

### Auto-log billable time

Every meaningful work block during a PPP session appends to `~/Desktop/PPP_Timesheet.md` AND the current week's `~/Desktop/PPP_Invoice_NNN.md`. Conservative — iterative polish = 0.25-0.50h, NOT full hours. See `feedback_ppp_auto_log_in_session.md` + `project_ppp_invoice_cadence.md` + `feedback_ppp_invoice_style.md` + `feedback_ppp_invoice_contact_email.md`.

### Weekly invoice cadence

Invoices ship every Sunday covering Mon-Sun. Monday starts a fresh PPP-00N file with only that week's work. Timesheet stays cumulative across weeks. See `project_ppp_invoice_cadence.md`.

### Strategy doc on Desktop

`~/Desktop/PPP_Strategy_Notes.md` is the live meeting talking-points doc — one page max, plain English, only active decisions + open questions for PPP. Update it whenever decisions change. See `feedback_ppp_strategy_doc_on_desktop.md`.

---

## Architecture map

```
app/
├── (login)/         — public branded login page (Google SSO; placeholder today)
├── dashboard/       — authenticated app surfaces (Command Center proper)
│   ├── page.tsx     — Company Overview (KPIs, revenue trend, mix, regional, funnel, leaderboard)
│   ├── rep/         — Rep Profiles index + per-rep drill-in
│   ├── orders/      — Materials Orders (Phase 2A — not built yet)
│   ├── selections/  — Color Selections (Phase 2B — not built yet)
│   └── receipts/    — Receipts queue (Phase 3 — not built yet)
└── select/[token]/  — public customer-facing color portal (Phase 2B — not built yet)

components/
├── dashboard-chrome.tsx     — sidebar + topbar shell, mobile drawer
├── dashboard-view.tsx       — client-side Overview with filter state
├── sidebar.tsx              — top-level nav (Overview, Rep Profiles, future)
├── topbar.tsx               — greeting + live sync indicator
├── kpi-card.tsx
├── trend-chart.tsx          — SVG line/area chart with tooltips
├── horizontal-bar.tsx
├── leaderboard.tsx          — sortable, mobile-card-fallback
├── filter-dropdown.tsx
└── page-header.tsx

lib/
├── brand.ts            — PPP brand constants (palette, voice, social, contact)
├── data-source.ts      — SF adapter boundary; today re-exports mock; tomorrow becomes SF
└── mock-data.ts        — deterministic mock SF data + filter engine (getFilteredView)

public/brand/           — logo SVGs + official PNGs from the brand-guide deck
docs/                   — planning docs (PHASE_2_PLAN.md, etc.)
```

---

## Current state (end of day 2026-05-19)

- **Command Center V1 live** at the Vercel URL. Dashboard + per-rep drill-in + sortable leaderboard + filters + mobile-perfect.
- **Brand-aligned:** Roboto fonts, official PPP palette, navy primary text, official logo PNGs.
- **Filter engine:** period (7d / 30d / 90d / 6m / 12m / YTD) × region (All + Suffolk/Nassau/Queens/Brooklyn dynamically derived).
- **All data is mock** until Salesforce wiring lands.
- **Auth is placeholder** — login button skips OAuth. Must wire real Google SSO before SF data flows (see `project_ppp_auth_setup_pending.md`).
- **Subdomain locked:** `hub.precisionpaintingplus.net` (DNS CNAME pending PPP IT).
- **Phase 2 plan ready:** `docs/PHASE_2_PLAN.md` (Plan B — Materials Ordering FIRST, Color Selection SECOND).
- **Open questions for PPP:** see `~/Desktop/PPP_Strategy_Notes.md` (16 questions, Q13-16 added today).

---

## Standing pending actions

1. **🟡 Tomorrow first thing:** Karan creates Google Cloud OAuth project under `developer@precisionpaintingplus.net` (~15 min). Steps in `project_ppp_auth_setup_pending.md`.
2. **🟡 Tomorrow:** Salesforce sandbox access expected from PPP IT (via Katie). Once it lands, wire SF lookup into Command Center.
3. **🟡 Tomorrow / soon:** PPP IT publishes DNS CNAME for `hub.precisionpaintingplus.net`.
4. **🟢 Pending PPP answers:** the 16 open questions in `PPP_Strategy_Notes.md` (Phase 2 / supplier setup / OAuth / new-customer SF fields).

---

## Useful commands

```bash
# Dev server (Turbopack)
npm run dev

# Type check
npx tsc --noEmit

# Test the live URL via curl
curl -s -o /dev/null -w "HTTP %{http_code}\n" https://hub.precisionpaintingplus.net/

# Git push (PAT-inline pattern documented in project_ppp_auth_setup_pending; PAT also strippable from .git/config)
git push origin main
```

---

## Files Karan keeps on Desktop (NOT in this repo)

- `~/Desktop/PPP_Strategy_Notes.md` — live meeting talking points (one page max)
- `~/Desktop/PPP_Timesheet.md` — cumulative timesheet across all weeks
- `~/Desktop/PPP_Invoice_NNN.md` — current week's invoice (PPP-001 in week 1)
- `~/Desktop/PPP_Brand_Guide_Company_Deck-2023.pptx` — source brand guide
