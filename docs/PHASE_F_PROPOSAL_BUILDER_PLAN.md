# Phase F — Proposal Builder

**Locked 2026-07-14.** Source spec: `project_karan_2026_07_13_directives.md` + `project_tomco_proposal_format.md` (extracted from 5 real 2026 Tomco proposals). Do not deviate without checking Katie.

---

## Why this is the crown jewel

Right now Alex writes proposals in Word, exports PDF, uploads as a Document, and manually flips the status to Proposal Sent. Every proposal takes ~45 minutes. Phase F collapses that to:

1. Click "New proposal" on a deal.
2. Pick inclusions from the Product Library (Phase D catalog auto-suggests).
3. Pick exclusions from the Exclusions Library (Phase F.0 seed).
4. Click Send → PDF snapshots into Documents + status auto-flips to Proposal Sent + activity note posts.

Target: ~5 minutes per proposal.

---

## Phase F.0 — Exclusions Library (pre-req, ~2h)

### Migration 054 — `commercial_exclusions`

```sql
CREATE TABLE IF NOT EXISTS public.commercial_exclusions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'optional', -- 'standard' | 'optional'
  is_active BOOLEAN NOT NULL DEFAULT true,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS commercial_exclusions_active_idx
  ON public.commercial_exclusions (is_active, deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS commercial_exclusions_use_count_idx
  ON public.commercial_exclusions (use_count DESC) WHERE deleted_at IS NULL;
```

### Seed — 8 canonical Tomco exclusions (observed across 5 proposals)

Category `standard` (auto-added by default to new proposals):
- `Work to be completed during normal business hours.`
- `Sales Tax, unless applicable.`

Category `optional` (searchable, hand-picked per proposal):
- `Materials`
- `Wallcovering & Areas Not in Contract (NIC)`
- `Trim & Built-in Cabinetry`
- `Cement Floor and Cement Wall Paint`
- `Exterior Paint`
- `Existing HM Doors`
- `Lift excluded, price will increase if needed`
- `Decorative Finish Wall & Ceiling`

### Admin CRUD

- `/commercial/pre-job/exclusions` — list + search + create + edit + soft-delete.
- Mirrors `/commercial/pre-job/products` shape (same table styling, admin gate, tap-target-safe rows).
- Blank state with admin-only "add the first one" CTA.
- Sidebar "Exclusions" entry flipped from `disabled: true, phase: 5` → live under Pre-Contract.

### `<ExclusionPicker>` client component

Same pattern as `<ProductPicker>`:
- Searchable combobox, prefix-first ranking on `text`.
- 25-row cap with "see more" hint.
- Multi-select — chips appear below input, click × to remove.
- "Add new to library" fallback — inline text field creates a new `commercial_exclusion` row + auto-adds it.
- Full ARIA (`role=combobox`, `aria-expanded`, `aria-controls`, `aria-activedescendant`).
- Hidden `<input type="hidden" name="exclusion_ids" value="[uuid,uuid,...]">` for form submit.

---

## Phase F.1 — Proposals schema + lib scaffold (~2h)

### Migration 055 — `commercial_proposals` + `commercial_proposal_line_items`

```sql
CREATE TABLE IF NOT EXISTS public.commercial_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES public.commercial_opportunities(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL DEFAULT 1,
  -- Header block: cached from the deal + account at create time so PDF snapshots
  -- don't shift if the account address is edited later. JSONB for flexibility.
  header_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Body overrides — null = fall back to Tomco defaults.
  intro_text_override TEXT,
  alternate_notes TEXT,
  bid_notes TEXT,  -- hidden on PDF unless populated
  -- Exclusion references (multi-select from Phase F.0 library).
  exclusion_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  -- Rollup — sum of line items with is_alternate=false. Cents.
  total_cents BIGINT NOT NULL DEFAULT 0,
  -- Rendering mode.
  pdf_show_line_prices BOOLEAN NOT NULL DEFAULT false, -- Tomco default = hide
  -- Lifecycle.
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','pending_approval','sent','won','lost','expired','superseded'
  )),
  sent_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  -- Document snapshot on Send.
  snapshot_document_id UUID REFERENCES public.commercial_documents(id) ON DELETE SET NULL,
  -- Chain revisions: each new rev points to its parent.
  parent_proposal_id UUID REFERENCES public.commercial_proposals(id) ON DELETE SET NULL,
  -- Audit.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS commercial_proposals_opp_idx
  ON public.commercial_proposals (opportunity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS commercial_proposals_status_idx
  ON public.commercial_proposals (status) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS commercial_proposals_opp_rev_uniq
  ON public.commercial_proposals (opportunity_id, revision_number) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.commercial_proposal_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES public.commercial_proposals(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.commercial_products(id) ON DELETE SET NULL,
  -- Snapshotted so a Product edit doesn't rewrite historical proposals.
  description TEXT NOT NULL,
  quantity NUMERIC(12,3) NOT NULL DEFAULT 1,
  unit TEXT NOT NULL,
  unit_price_cents BIGINT NOT NULL DEFAULT 0,
  -- Alternates render in a separate section + excluded from TOTAL.
  is_alternate BOOLEAN NOT NULL DEFAULT false,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commercial_proposal_line_items_proposal_idx
  ON public.commercial_proposal_line_items (proposal_id, position);
```

### `lib/commercial/proposals/` scaffold

- `constants.ts` — status enum + label helpers + Tomco default intro text (verbatim from memory).
- `db.ts` — full CRUD + `logInsert/logUpdate/logDelete` audit hooks + `recomputeTotal(proposalId)` helper triggered on any line-item mutation.
- `pdf.tsx` — react-pdf `<ProposalPDF>` document matching Tomco layout.

---

## Phase F.2 — Editor UI (~5h)

### Route

`/commercial/accounts/[id]/deals/[dealId]/proposal` — nested under the account so a proposal always has a deal + customer context.

- `[dealId]/proposal` — list of revisions (R1, R2, R3…) with status pills.
- `[dealId]/proposal/[proposalId]` — edit view.
- `[dealId]/proposal/new` — creates the first R1 draft or bumps from the latest.

### Editor sections (top → bottom, mirrors Tomco PDF order)

1. **Header block** (auto-filled from account + deal, editable inline):
   - GC company name → `account.company_name`
   - Address → `account.address_street/city/state/zip`
   - Attention → `opp.primary_contact_id` name (fallback: account primary)
   - Phone / Email → contact record
   - PROJECT: → `opp.location_short` (address stack)
2. **Intro block** — Tomco default paragraph; textarea override.
3. **Inclusions** — `<ProductPicker>` add-a-line + repeating row editor. Each row:
   - Bolded item name (auto from product `name`, editable)
   - Description (auto from product `default_description`, editable)
   - Qty × Unit × Unit Price (cents) — auto-fill from ProductPicker via `/api/commercial/products/resolve?product_id=X&account_id=Y` (customer override precedence).
   - Drag-reorder handle (position column).
   - "Move to Alternates" toggle.
4. **TOTAL** — right-aligned, auto-computed from line items (`is_alternate=false`).
5. **Alternates** — same picker/row shape, isolated section, ADD ALTERNATE right-aligned per row.
6. **Exclusions** — `<ExclusionPicker>` multi-select, pre-seeded with 2 standard bullets.
7. **Bid Notes** — textarea. Only rendered on PDF if non-empty.
8. **Estimator sign-off** — auto-filled from `opp.estimator_user_id` name+phone+email; editable.
9. **PDF mode toggle** — "Show line-item prices on PDF" (default OFF — matches Tomco convention).

### Actions

- **Save draft** (autosave every 3s on dirty state).
- **Bump revision** — creates a new proposal row with `parent_proposal_id = current`, copies line items, marks the previous `superseded`.
- **Send** — status → `sent`, snapshots PDF as a `commercial_document` (`kind=proposal`, favorited), auto-flips opp to `proposal/sent`, posts account note "Proposal R2 sent to WestWood Contracting."
- **Mark won / lost** — routes into the existing Win/Loss debrief flow.

---

## Phase F.3 — PDF export (~4h)

`app/api/commercial/proposals/[id]/pdf/route.ts` — GET returns `application/pdf`. React-pdf renders inline (already installed, no queue needed for our size).

Layout matches `project_tomco_proposal_format.md` verbatim:
- Red keyline border + Tomco logo top-center
- Date top-right
- PROPOSAL SUBMITTED TO block
- PROJECT block
- Standard intro paragraph (from constants.ts)
- Inclusions — bold-lead bullets (`●` glyph), narrative-mode by default
- TOTAL right-aligned (or "Labor Only TOTAL" if Materials in exclusions)
- Alternate section (if any)
- Exclusions bullets
- Yellow highlight banner (if `header_json.show_capital_improvement_notice = true`)
- Estimator sign-off
- Red keyline footer with Tomco address

Two render modes:
- **Customer PDF** (default): narrative bullets, single TOTAL, no per-line prices.
- **Internal PDF** (`?mode=internal`): line items with prices — shows Alex/Katie the estimator math.

---

## Phase F.4 — Cross-surface wiring + audit (~2h)

- Sidebar Proposals entry unlocks (already at `phase: 6, disabled`).
- Opportunity detail Header — "Proposal" tab shows revisions list + latest status.
- Sending a proposal fires `insertCommercialProposalSentNotifications` bell.
- Won-drop from Kanban still routes debrief through existing E-6 flow; no changes there.
- 3-lane post-audit (schema race + PDF rendering fidelity vs Tomco spec + copy/UX consistency).

---

## Test cases (must pass before ship)

1. Create R1 proposal from a Qualifying deal → inclusions from ProductPicker → save draft → close browser → reopen → data intact.
2. Bump R1 → R2 → R1 marked `superseded`, R2 is `draft`, line items copied.
3. Add an Alternate line → TOTAL doesn't include it → PDF shows ADD ALTERNATE right-aligned.
4. Add "Materials" exclusion → TOTAL label flips to "Labor Only TOTAL".
5. Send → PDF snapshot lands in Documents tab, deal status flips to Proposal Sent, account note posted.
6. Send with `show_capital_improvement_notice=true` → yellow banner renders on PDF.
7. Won a proposal → Win debrief modal fires (existing E-6 flow) → Start Project card offers Won→Pre-Construction handoff.
8. Reopen a Won deal → all past proposal revisions still visible + read-only.
9. Estimator on team but not the deal's estimator can view but not edit (admin bypass).
10. PDF renders on the account debrief URL — no Word download needed.

---

## Out of scope for Phase F (queued for later)

- E-signature via S-Sign (Phase G).
- Bundled products (paint + primer + sundries as one pick).
- Multi-tier pricing (contractor / retail / spec).
- Auto-conversion Won → Project record (Phase G).
- ZIP → sales tax on totals (Phase I).
- Deal → Opportunity user-facing rename sweep (Phase F.5 after F ships clean).

---

## Non-negotiables

- Product Library (Phase D) is the ONLY source of truth for pricing. No inline `product_default_unit_price` copies that could drift.
- Snapshot pattern on line items: `unit_price_cents` freezes at line-item create so a Product catalog edit doesn't rewrite a sent proposal.
- Every mutation goes through `logInsert/logUpdate/logDelete` — audit-log is load-bearing for the "which R got sent when to whom" question.
- Katie/Alex don't have to reopen a proposal to reprint the PDF — the snapshot Document is downloadable directly from the Docs tab.
