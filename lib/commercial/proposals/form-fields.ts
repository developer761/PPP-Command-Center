/**
 * Which fields did a proposal form actually carry?
 *
 * The proposal save used to read EVERY field and write all of them, so a form
 * carrying only some of them silently blanked the rest. That is why a separate
 * rename action had to exist, and it is what stood between us and Stephanie's
 * requested section order (2026-08-13) — her sequence interleaves the autosave
 * block with the line-item forms, so the big form has to split, and under the
 * old behaviour each part would erase the others.
 *
 * A form DECLARES what it carries in a hidden `__fields` input. Only declared
 * fields are written; `updateProposal` already treats undefined as "leave
 * alone".
 *
 * The declaration is explicit rather than inferred from what FormData contains,
 * and that is the whole design decision: **an unchecked checkbox is absent from
 * FormData**. Inferring presence would make "unchecked" indistinguishable from
 * "not on this form", so unticking a box would never save — a data-loss bug
 * traded for a different data-loss bug.
 *
 * A form with no declaration keeps whole-form behaviour, so nothing changes
 * until a form opts in.
 */

export const FIELDS_INPUT_NAME = "__fields";

/** Every field the proposal editor can write, grouped as the form splits. */
export const PROPOSAL_FIELD_GROUPS = {
  header: [
    "gc_company",
    "attention",
    "title",
    "phone",
    "email",
    // NOT `project_name`. It is owned by the sticky AutosaveProposalName form
    // and its own narrow rename action — there is deliberately no
    // project_name input inside the header block ("a second project_name input
    // here reverted it on any body-field autosave", R4 #3).
    //
    // Declaring it here anyway meant the header form claimed a field it does
    // not carry: `formData.get("project_name")` came back null, the action
    // wrote `undefined`, and because header_json is replaced whole, the name
    // was dropped from the column on every header keystroke. Silently, too —
    // background saves skip revalidation, so the title stayed on screen until
    // the next full render. Found by the 2026-08-13 persona audit; introduced
    // by the section-order change that same day, which is the exact bug that
    // change existed to prevent.
    "project_address",
    "date_iso",
    "show_cip_notice",
    "gc_address_lines",
    // The Bid Set date input sits in the Header panel, not the intro — even
    // though its VALUE prints inside the intro sentence. Groups describe which
    // form carries a field, not where it ends up on the PDF.
    "bid_set_date",
  ],
  intro: ["intro_text_override"],
  qualifications: ["alternate_notes"],
  exclusions: ["exclusion_ids", "custom_exclusions"],
  bidNotes: ["bid_notes"],
  pdfOptions: ["pdf_show_line_prices", "pdf_compact", "final_price_override"],
  estimator: ["est_name", "est_title", "est_phone", "est_email"],
} as const;

export type ProposalFieldGroup = keyof typeof PROPOSAL_FIELD_GROUPS;

/** The value for a form's hidden `__fields` input, given the groups it holds. */
export function fieldsFor(...groups: ProposalFieldGroup[]): string {
  return groups.flatMap((g) => [...PROPOSAL_FIELD_GROUPS[g]]).join(",");
}

/**
 * Null when the form made no declaration (write everything, as before);
 * otherwise the exact set it declared.
 */
export function carriedFields(raw: string | null | undefined): Set<string> | null {
  const declared = (raw ?? "").trim();
  if (!declared) return null;
  return new Set(declared.split(",").map((f) => f.trim()).filter(Boolean));
}

/** `carries(name)` — may this submission write that field? */
export function makeCarries(raw: string | null | undefined): (name: string) => boolean {
  const set = carriedFields(raw);
  return (name: string) => (set ? set.has(name) : true);
}
