# Paint Gallon Estimation Calculator — Integration Plan

> **Status: PARKED (saved 2026-05-29).** Resume after Katie's walkthrough fixes + speed work.
> Goal: PaintScout-style takeoff that estimates gallons per color/area from the Work Order
> data and drops clean quantities straight into the supplier email draft — worker does
> near-zero work. Supplier email shows NO "estimate" wording; the app shows an
> "estimate only" banner so workers review before sending.

## What the WOLI data actually gives us (live SF, 2,000-row sample, 2026-05-29)

| Field | Populated | Verdict |
|---|---|---|
| `Sq_Footage__c` | 85% | ✅ the one real measurement |
| `of_Coats__c` | 97% | ✅ reliable |
| `Surfaces__c` (multipicklist: Walls;Ceiling;Trim;Floor;Accent Wall;Cabinets;Door;Window;Closet;Shelves) | 92% | ✅ reliable |
| `Wall_Surface_Area__c` | 0% | ❌ never filled (builder reads it — dead) |
| `Perimeter__c` (trim linear ft) | 0% | ❌ unusable |
| `Primer__c` (Spot Prime/Latex/Oil), `NumberDoors/Windows/Closets__c` | 0% | ❌ unusable |
| `Dimensions_Height__c` | sparse | wall-area derivation not reliable |
| `Prep_Level__c` (1-Basic…4-Supreme), `Surface_Start__c` (deterioration) | present | refinement only |
| Per-surface colors + finishes (`ColorWall/Ceiling/Trim/Floor/Other__c` + `Finish*__c`) | present | ✅ wall/ceiling/trim/floor/other each carry a color + finish |
| Finish picklist | — | Flat / Matte / Eggshell / Satin / Pearl / Semigloss / Gloss / Kitchen & Bath (Regal) / Bath & Spa (Aura) / Low Lustre / Soft Gloss |

**Surfaces combos (real):** Walls;Ceiling;Trim (866) · Walls;Trim (350) · Walls (300) · Walls;Ceiling (130) · Trim (101) · Ceiling (54) …

## The pivotal constraint

PaintScout works because estimators measure each surface separately. **PPP captures ONE `Sq_Footage__c` per line + a multi-surface picklist.** Most lines (Walls;Ceiling;Trim) share a single sqft. So we cannot do a true per-surface takeoff from current data — we need a **surface-allocation model**, and first must nail down what that one sqft number means.

## ⚠️ #1 gating decision (Katie)
**What does `Sq_Footage__c` mean on a multi-surface line?** (a) room floor area, (b) total paintable wall area, (c) loose estimator entry. Every coverage number depends on this. Resolve via data-analysis pass + Katie confirmation before any accurate gallons ship.

## Edge cases & bugs mapped
1. **Existing bug:** current builder uses the line's full sqft for *each* color (wall AND ceiling AND trim) → triple-counts. Calculator must allocate, not duplicate.
2. 15% of lines have no sqft → show "needs measurement," never guess.
3. Multi-surface line, one sqft → allocation ratios (walls/ceiling/trim split).
4. Second coat covers ~10–15% more than the first.
5. Primer = separate can, but field unpopulated → only when worker toggles / prep implies.
6. Finish/sheen = different SKU even same color → split by finish.
7. Round up per color-can (each custom tint is its own purchase), min 1 gal (quart for tiny trim?).
8. Waste buffer (~5–10%) vs the already-conservative 350 sqft/gal — pick ONE, don't stack.
9. `Surface_Start__c` deterioration + prep level affect absorption (refinement).
10. Worker gallon override must persist + not be clobbered by a re-fetch (reuse editedBody pattern).
11. Exterior/deck coatings ≠ interior wall coverage.
12. "Estimate" wording app-only; supplier email shows clean quantities.

## Phased plan
- **Phase 0 — Foundation (no code):** data-analysis on `Sq_Footage__c` + Katie confirms meaning + coverage numbers (per-surface or one house standard). Gate.
- **Phase 1 — Coverage config:** `paint_coverage_rates` (Supabase table + admin editor + BM-published defaults), keyed by surface + optional finish/product. Tunable without deploy.
- **Phase 2 — Pure calculator:** `lib/supplier-order/estimate-gallons.ts` — input WOLI + config → per-color/per-finish gallons with allocation, coat-2 efficiency, buffer, per-can round-up, min-1, quart threshold. Fully unit-tested.
- **Phase 3 — Wire into builder:** replace `ceil(coats×sqft/350)`; aggregate identical color+finish across rooms; fixes the triple-count bug.
- **Phase 4 — Email + banner:** supplier email clean quantities (NO "estimate"); app modal banner "⚠ Paint quantities are system estimates — review before sending" + per-line "estimated" tag (app-only).
- **Phase 5 — Worker edit UX:** per-line gallon stepper, persists through re-fetches, "reset to estimate."
- **Phase 6 — Validation + sign-off:** run across N recent completed WOs, compare to what PPP actually ordered, tune coverage with Katie, then flip on.

## Decisions needed before building
1. Katie: meaning of `Sq_Footage__c` + coverage numbers.
2. Karan/Katie: waste buffer policy (keep conservative 350 OR add 10% — not both).
3. Karan: quart support for tiny trim, or gallons-only.
4. Karan: do estimators start entering per-surface measurements in SF (unlocks true accuracy) or live with allocation-on-one-sqft.
