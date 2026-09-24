/**
 * ONE-OFF — rewrite the product library in Brendan's house style.
 *
 * Run:
 *   node --env-file=.env.local scripts/rename-products-brendan-style.mjs
 *   node --env-file=.env.local scripts/rename-products-brendan-style.mjs --commit
 *
 * Brendan 2026-09-23, with the approved Tesla CC proposal as the reference:
 *
 *   ours   Prime & Paint Gypsum Walls 2 Coats — Primer + 2 finish coats on
 *          new/patched drywall.
 *   theirs GWB Wall: Standard preparation, apply 2 finish coats.
 *
 * The convention in the document Tomco actually sends: the NAME is the thing
 * being painted — no verbs, no coat counts — and the DESCRIPTION is the work.
 * Ours put the work in the name and then repeated it underneath, which is why
 * a scope line read twice.
 *
 * TWO RULES THIS FOLLOWS, and they are the reason it can be run unattended:
 *
 *  1. IT NEVER INVENTS SCOPE. A coat count only appears in the new description
 *     if it was already in the old name or the old description. Where the
 *     source says nothing about coats, neither does the rewrite — "Standard
 *     preparation and paint." A proposal is a priced promise; adding "2 finish
 *     coats" to a line that never said so would quietly change what Tomco owes
 *     the GC.
 *  2. IT NEVER TOUCHES A PRICE, A UNIT, OR A SKU. Name and description only.
 *
 * Existing proposals are unaffected: a line item snapshots the name and
 * description when it is added (migration 071), so only lines added from here
 * on pick up the new wording. Karan confirmed this is wanted.
 *
 * Separately, it repairs a seeding artifact: 38 of the 58 descriptions carry a
 * stray line break mid-sentence. The PDF reads a newline as "this is a list"
 * and splits the line into sub-bullets — so "Prep only — skim\n coat for
 * level-4 finish." printed as two bullets broken mid-sentence. The renderer is
 * right; the data was wrong.
 */
import { createClient } from "@supabase/supabase-js";

const COMMIT = process.argv.includes("--commit");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("Run with --env-file=.env.local");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

/**
 * old name → [new name, new description]
 *
 * Where a line is left out, only the stray line breaks are repaired — the
 * equipment, labor and sundry rows are not scope lines on a GC's proposal and
 * read fine as they are.
 */
const RENAMES = {
  // ── Walls + ceilings ────────────────────────────────────────────────────
  "Prime & Paint Gypsum Walls 2 Coats": ["New Gypsum Walls", "Standard preparation, apply 1 primer coat and 2 finish coats."],
  "Paint Gypsum Wall 2 Coats": ["Gypsum Walls", "Standard preparation, apply 2 finish coats."],
  "Skim Coat Gypsum Walls": ["Gypsum Walls — Skim Coat", "Skim coat to a level-4 finish. Preparation only."],
  "Drywall Ceiling": ["GWB Ceiling", "Standard preparation and paint."],
  "Prime & Paint Wood Walls 2 Coats": ["Wood Walls", "Standard preparation, apply 1 primer coat and 2 finish coats."],
  "Wood Walls Clear Coat": ["Wood Walls — Clear Coat", "Standard preparation, apply clear coat."],
  "Ceiling Grid": ["Ceiling Grid", "Standard preparation and paint. Suspended T-bar grid."],
  "Exposed Ceiling Deck & Joist": ["Exposed Ceiling Deck and Joist", "Standard preparation and paint."],
  "Exposed Duct Work": ["Exposed Duct Work", "Standard preparation and paint."],
  "Interior CMU Walls - Block Fill & Paint 1 Coat": ["Interior CMU Walls", "Standard preparation, block fill and apply 1 finish coat."],

  // ── Exterior ────────────────────────────────────────────────────────────
  "Exterior CMU Walls - Paint": ["Exterior CMU Walls", "Standard preparation and paint."],
  "Exterior CMU Walls - Power Wash & Paint 2 Coats Elastomeric Flat": ["Exterior CMU Walls — Elastomeric", "Power wash, apply 2 finish coats elastomeric flat."],
  "Exterior EIFS - Paint 2 Coats Flat": ["Exterior EIFS", "Standard preparation, apply 2 finish coats flat."],
  "Exterior Split Face Block - Power Wash & Apply 2 Coats Okon Plugger": ["Exterior Split Face Block", "Power wash, apply 2 coats Okon Plugger."],
  "Precast Concrete Panels - Power Wash & Paint 2 Coats Loxon": ["Precast Concrete Panels", "Power wash, apply 2 finish coats Loxon."],
  "Standing Seam Roof - Prep & Paint": ["Standing Seam Roof", "Standard preparation and paint."],
  "Steel I Beams": ["Steel I Beams", "Standard preparation and paint."],
  "Steel Lintels": ["Steel Lintels", "Standard preparation and paint."],
  "Gas Pipes": ["Gas Pipes", "Standard preparation and paint."],
  "Drip Cap": ["Drip Cap", "Standard preparation and paint."],
  "Soffits": ["Soffits", "Standard preparation and paint."],
  "Roof Ladder": ["Roof Ladder", "Standard preparation and paint."],
  "Pipe Railing": ["Pipe Railing", "Standard preparation and paint."],
  "Bollards": ["Bollards", "Standard preparation, apply 2 finish coats."],

  // ── Doors, frames, windows ──────────────────────────────────────────────
  "HM Door - Prep & Paint 2 Coats": ["HM Door", "Standard preparation, apply 2 finish coats."],
  "HM Frame - Prep & Paint 2 Coats": ["HM Frame", "Standard preparation, apply 2 finish coats."],
  "Door & Frame - Prep & Paint 2 Coats": ["Door and Frame", "Standard preparation, apply 2 finish coats."],
  "HM Frame & Wood Door": ["HM Frame and Wood Door", "Hollow-metal frame with a wood door. Pick the finish system below."],
  "HM Frame & Wood Door (Seal & Poly)": ["HM Frame and Wood Door — Seal and Poly", "Frame painted; wood door sealed and finished clear."],
  "HM Frame & Wood Door (Stain, Seal & Poly)": ["HM Frame and Wood Door — Stain, Seal and Poly", "Frame painted; wood door stained, sealed and finished clear."],
  "Wood Door - Stain, Seal, & Poly": ["Wood Door", "Stained, sealed and finished clear."],
  "OH Door Frame": ["Overhead Door Frame", "Standard preparation and paint."],
  "Side Light": ["Side Light", "Standard preparation and paint."],
  "Window Frame - Prep & Paint 2 Coats": ["Window Frame", "Standard preparation, apply 2 finish coats."],
  "Window Sash - Prep & Paint 2 Coats": ["Window Sash", "Standard preparation, apply 2 finish coats."],
  "Corner Guard - Paint": ["Corner Guard", "Standard preparation and paint."],

  // ── Trim ────────────────────────────────────────────────────────────────
  "Base Molding - Prep & Paint 2 Coats": ["Base Molding", "Standard preparation, apply 2 finish coats."],
  "Chair Rail - Prep & Paint 2 Coats": ["Chair Rail", "Standard preparation, apply 2 finish coats."],
  "Crown Molding - Prep & Paint 2 Coats": ["Crown Molding", "Standard preparation, apply 2 finish coats."],
  "Wood Cap - Prep & Paint 2 Coats": ["Wood Cap", "Standard preparation, apply 2 finish coats."],
  "Fireplace Mantel - Prep & Paint 2 Coats": ["Fireplace Mantel", "Standard preparation, apply 2 finish coats. Mantel and surround."],
  "Stair Trim per flight": ["Stair Trim", "Standard preparation and paint. Priced per flight."],
  "Columns - Paint 2 Coats": ["Columns", "Standard preparation, apply 2 finish coats."],
  "Radiators - Prep & Paint 2 Coats": ["Radiators", "Standard preparation, apply 2 finish coats."],

  // ── Floors ──────────────────────────────────────────────────────────────
  "Floor Paint": ["Floors", "Standard preparation and paint."],
  "Line Striping": ["Line Striping", "Floor and parking line striping."],

  // ── Prep + sundries that DO appear as scope lines ───────────────────────
  "Power Washing": ["Exterior Power Wash", "Standard preparation."],
  "Caulk Control Joints": ["Caulk Control Joints", "Seal exterior control joints."],
  "Wallcovering Removal": ["Wallcovering Removal", "Strip existing wallcovering."],
  "Wallcovering Primer": ["Wallcovering Primer", "Prime walls before wallcovering is installed."],
};

const clean = (s) => (s ?? "").replace(/\s+/g, " ").trim();

const { data: products, error } = await sb
  .from("commercial_products")
  .select("id, name, description")
  .is("deleted_at", null);
if (error) {
  console.error("read failed:", error.message);
  process.exit(1);
}

let renamed = 0;
let repairedOnly = 0;
let unchanged = 0;

for (const p of products.sort((a, b) => a.name.localeCompare(b.name))) {
  const mapped = RENAMES[p.name];
  const newName = mapped ? mapped[0] : p.name;
  // Every description gets the stray line breaks squeezed out, renamed or not.
  const newDesc = mapped ? mapped[1] : clean(p.description);

  if (newName === p.name && newDesc === (p.description ?? "")) {
    unchanged += 1;
    continue;
  }

  if (mapped) {
    renamed += 1;
    console.log(`${p.name}`);
    console.log(`   → ${newName}: ${newDesc}`);
  } else {
    repairedOnly += 1;
    console.log(`(line breaks only) ${p.name}`);
  }

  if (COMMIT) {
    const { error: e } = await sb
      .from("commercial_products")
      .update({ name: newName, description: newDesc })
      .eq("id", p.id);
    if (e) console.log(`   ✗ ${e.message}`);
  }
}

console.log(
  `\n${renamed} renamed, ${repairedOnly} had line breaks repaired only, ${unchanged} already correct.`
);
const unmapped = products.filter((p) => !RENAMES[p.name]).map((p) => p.name);
console.log(`\nNOT renamed (equipment, labor, wallcovering units — not GC scope lines):`);
for (const n of unmapped.sort()) console.log(`   ${n}`);
if (!COMMIT) console.log("\nDry run. Re-run with --commit to write.");
