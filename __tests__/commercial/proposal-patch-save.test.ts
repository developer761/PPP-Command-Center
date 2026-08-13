import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  makeCarries,
  carriedFields,
  fieldsFor,
  PROPOSAL_FIELD_GROUPS,
} from "@/lib/commercial/proposals/form-fields";

/**
 * Patch-only proposal saves.
 *
 * The save used to read every field and write all of them, so a form carrying
 * only some of them blanked the rest. Splitting the editor (needed for
 * Stephanie's section order) would have turned that into three forms erasing
 * each other on every keystroke.
 */

const SAVE_ACTION_FILE = join(
  __dirname,
  "..",
  "..",
  "app/commercial/accounts/[id]/deals/[dealId]/proposal/[proposalId]/page.tsx"
);

describe("field declaration", () => {
  it("no declaration means write everything — the old behaviour is intact", () => {
    // The combined editor form has not opted in, so it must keep working
    // exactly as before. A regression here silently stops saves landing.
    const carries = makeCarries("");
    expect(carries("gc_company")).toBe(true);
    expect(carries("anything_at_all")).toBe(true);
    expect(carriedFields(null)).toBeNull();
  });

  it("a declaration restricts writes to exactly what was declared", () => {
    const carries = makeCarries(fieldsFor("header"));
    expect(carries("gc_company")).toBe(true);
    expect(carries("intro_text_override")).toBe(false);
    expect(carries("bid_notes")).toBe(false);
  });

  it("an unchecked checkbox in a declared group still saves as unchecked", () => {
    // THE reason the declaration is explicit rather than inferred from
    // FormData. An unchecked box is absent from FormData, so inferring
    // presence would make "unticked" indistinguishable from "not on this
    // form" — and unticking would never persist.
    const fd = new FormData();
    fd.set("__fields", fieldsFor("pdfOptions"));
    // note: pdf_show_line_prices deliberately NOT set — that is what a
    // browser sends for an unticked checkbox.
    const carries = makeCarries(String(fd.get("__fields")));
    expect(carries("pdf_show_line_prices")).toBe(true);
    expect(fd.get("pdf_show_line_prices")).toBeNull();
    // Together: the field is writable, and its value reads as false.
    expect(fd.get("pdf_show_line_prices") === "on").toBe(false);
  });

  it("tolerates whitespace and empty entries in the declaration", () => {
    const carries = makeCarries(" gc_company , , bid_notes ");
    expect(carries("gc_company")).toBe(true);
    expect(carries("bid_notes")).toBe(true);
    expect(carries("")).toBe(false);
  });

  it("every group is non-empty and no field is claimed by two groups", () => {
    // A field in two groups would be written by whichever form saved last,
    // reintroducing the clobber this whole change exists to remove.
    const seen = new Map<string, string>();
    for (const [group, fields] of Object.entries(PROPOSAL_FIELD_GROUPS)) {
      expect(fields.length).toBeGreaterThan(0);
      for (const f of fields) {
        expect(seen.has(f), `${f} is in both ${seen.get(f)} and ${group}`).toBe(false);
        seen.set(f, group);
      }
    }
  });
});

describe("the save action guards every field it writes", () => {
  const src = readFileSync(SAVE_ACTION_FILE, "utf8");
  const call = (() => {
    const start = src.indexOf("const result = await updateProposal({");
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf("});", start));
  })();

  it("no property is written unconditionally", () => {
    // The regression this protects against: someone adds a field to the
    // action and forgets the guard, so that field is blanked by every
    // partial form. Nothing in TypeScript can see that.
    const exempt = new Set(["id", "updated_by_user_id"]);
    const offenders: string[] = [];
    for (const line of call.split("\n")) {
      const m = line.match(/^\s*([a-z_]+):\s*(.+?),?\s*$/);
      if (!m) continue;
      const [, key, value] = m;
      if (exempt.has(key)) continue;
      const guarded =
        value.includes("carries(") || value.includes("Touched ?") || value === "finalPriceOverride" || value === "bidSetDate";
      if (!guarded) offenders.push(`${key}: ${value}`);
    }
    expect(offenders, `unguarded proposal fields: ${offenders.join(" | ")}`).toEqual([]);
  });

  it("declared groups cover every field the action can write", () => {
    // If the action learns a new field but no group lists it, a split form
    // could never declare it — it would become unwritable rather than
    // clobbering, which is quieter but still wrong.
    const declared = new Set(Object.values(PROPOSAL_FIELD_GROUPS).flat() as string[]);
    for (const m of call.matchAll(/carries\("([a-z_]+)"\)/g)) {
      expect(declared.has(m[1]), `${m[1]} is guarded but in no field group`).toBe(true);
    }
  });
});

describe("the editor renders Stephanie's section order", () => {
  const src = readFileSync(SAVE_ACTION_FILE, "utf8");

  it("sections appear in the requested sequence", () => {
    // Stephanie 2026-08-13: "After Intro Paragraph it should be Inclusions,
    // Alternates, Alternate Descriptions (Qualifications), Labor, Exclusions,
    // Bid Notes, PDF Options, Estimator Sign Off."
    //
    // Worth pinning: this order is the whole reason the save had to become
    // patch-only, and a later edit that moves a panel back would quietly undo
    // both. Matched on the rendered section titles, in source order.
    const markers: [string, RegExp][] = [
      ["Header", /title="Header"/],
      ["Intro paragraph", /title="Intro paragraph"/],
      ["Inclusions", /title="Inclusions"/],
      ["Alternates", /title="Alternates"/],
      ["Qualifications", /title="Qualifications"/],
      ["Labor", /title="Labor"/],
      ["Exclusions", /title="Exclusions"/],
      ["Bid notes", /Bid notes <span/],
      ["PDF options", /title="PDF options"/],
      ["Estimator sign-off", /title="Estimator sign-off"/],
    ];
    const positions = markers.map(([name, re]) => {
      const m = re.exec(src);
      expect(m, `section not found: ${name}`).not.toBeNull();
      return { name, at: m!.index };
    });
    const sorted = [...positions].sort((a, b) => a.at - b.at).map((p) => p.name);
    expect(sorted).toEqual(markers.map(([n]) => n));
  });

  it("every split autosave form declares the fields it carries", () => {
    // A split form WITHOUT a declaration falls back to whole-form behaviour
    // and blanks whatever the other two own — the precise failure this design
    // exists to prevent, and it would be silent.
    const opens = [...src.matchAll(/<AutosaveProposalForm\b/g)].map((m) => m.index!);
    expect(opens.length).toBeGreaterThan(1);
    for (const at of opens) {
      const body = src.slice(at, src.indexOf("</AutosaveProposalForm>", at));
      expect(body, `an AutosaveProposalForm has no ${"__fields"} declaration`).toContain(
        "FIELDS_INPUT_NAME"
      );
      expect(body).toContain("fieldsFor(");
    }
  });

  it("the split forms between them declare every field group exactly once", () => {
    // A group listed twice means two forms both write it (last save wins);
    // a group listed nowhere means those fields became unwritable.
    const declared = [...src.matchAll(/fieldsFor\(([^)]*)\)/g)]
      .flatMap((m) => m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")))
      .filter(Boolean);
    expect([...declared].sort()).toEqual(Object.keys(PROPOSAL_FIELD_GROUPS).sort());
  });
});
