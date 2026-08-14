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

describe("a declared field must actually be rendered by the form that declares it", () => {
  const src = readFileSync(SAVE_ACTION_FILE, "utf8");

  /** The body of each <AutosaveProposalForm>…</AutosaveProposalForm>. */
  function formBodies(): { groups: string[]; body: string }[] {
    const out: { groups: string[]; body: string }[] = [];
    for (const m of src.matchAll(/<AutosaveProposalForm\b/g)) {
      const start = m.index!;
      const end = src.indexOf("</AutosaveProposalForm>", start);
      const body = src.slice(start, end);
      const decl = body.match(/fieldsFor\(([^)]*)\)/);
      if (!decl) continue;
      out.push({
        groups: decl[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean),
        body,
      });
    }
    return out;
  }

  it("every field a form declares has an input inside that same form", () => {
    // THE bug this file failed to catch. The header form declared
    // `project_name` while the only project_name input lived in a different
    // <form> (the sticky title, owned by the narrow rename action). So
    // formData.get returned null, the action wrote undefined, and because
    // header_json is replaced whole the proposal's name was erased on every
    // header keystroke — silently, since background saves skip revalidation.
    //
    // The earlier tests here only checked that a guarded field belonged to
    // SOME group and that groups were declared once. Neither can see a
    // declaration with no matching input: exactly the "list in two places"
    // class, where the second place is JSX.
    // Two fields are rendered by a CHILD component, which builds their names
    // from a template literal, so they cannot be seen by scanning the page.
    // Rather than ignore them, follow the indirection: the child must be
    // mounted inside the form AND must really render that input.
    const VIA_CHILD: Record<string, { component: string; file: string }> = {
      exclusion_ids: { component: "ExclusionPicker", file: "components/commercial/exclusion-picker.tsx" },
      custom_exclusions: { component: "ExclusionPicker", file: "components/commercial/exclusion-picker.tsx" },
    };

    const missing: string[] = [];
    for (const { groups, body } of formBodies()) {
      for (const g of groups) {
        for (const field of PROPOSAL_FIELD_GROUPS[g as keyof typeof PROPOSAL_FIELD_GROUPS] ?? []) {
          const direct =
            new RegExp(`name=["']${field}["']`).test(body) ||
            // DateField/pickers pass the name through a prop of the same shape.
            new RegExp(`name=\\{?["']${field}["']`).test(body);
          if (direct) continue;

          const via = VIA_CHILD[field];
          if (via) {
            const mounted = new RegExp(`<${via.component}\\b`).test(body);
            const childSrc = readFileSync(join(__dirname, "..", "..", via.file), "utf8");
            // Matches both name="x" and name={`${prefix}x`}.
            const childRenders = new RegExp(`name=\\{?\`?[^"'\`]*["'\`]?\\}?`).test(childSrc)
              ? new RegExp(`${field}\`?\\}`).test(childSrc) || new RegExp(`name="${field}"`).test(childSrc)
              : false;
            if (mounted && childRenders) continue;
            missing.push(`${g}.${field} (expected via <${via.component}>: mounted=${mounted}, childRenders=${childRenders})`);
            continue;
          }
          missing.push(`${g}.${field}`);
        }
      }
    }
    expect(
      missing,
      `declared but never rendered (writes undefined over the stored value): ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("no input posts a field its own form has not declared", () => {
    // The mirror image: an input whose field is not in the form's declaration
    // is simply never saved, and nothing reports it.
    const known = new Set(Object.values(PROPOSAL_FIELD_GROUPS).flat() as string[]);
    const undeclared: string[] = [];
    for (const { groups, body } of formBodies()) {
      const declared: Set<string> = new Set(
        groups.flatMap((g) => [
          ...((PROPOSAL_FIELD_GROUPS[g as keyof typeof PROPOSAL_FIELD_GROUPS] ?? []) as readonly string[]),
        ])
      );
      for (const m of body.matchAll(/name="([a-z_]+)"/g)) {
        const n = m[1];
        if (n.startsWith("__") || !known.has(n)) continue;
        if (!declared.has(n)) undeclared.push(n);
      }
    }
    expect(undeclared, `rendered but not declared (never saves): ${undeclared.join(", ")}`).toEqual([]);
  });
});
